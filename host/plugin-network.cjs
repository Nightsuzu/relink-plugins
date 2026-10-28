'use strict';
// Plugin API v4 `net.fetch`: the host makes HTTPS requests on a plugin's behalf, only to the
// hosts its signed manifest declares. Plugin pages themselves keep `connect-src 'none'`.
// Requests never carry Relink cookies or sessions, never reach loopback or private networks
// (checked on the resolved address, so DNS cannot point a declared name inward), and user
// secrets are filled into headers here, so a plugin never sees the key it sends.
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'cookie2', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'expect', 'proxy-authorization', 'proxy-connection', 'origin', 'referer']);
const MAX_REQUEST = 1024 * 1024, MAX_RESPONSE = 8 * 1024 * 1024, TIMEOUT = 120000, PER_MINUTE = 60, CONCURRENT = 4, LOG = 50;
const SECRET = /\{\{secret:([a-z][a-z0-9-]{1,31})\}\}/g;

// Separate lists: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const blocked4 = new net.BlockList(), blocked6 = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked6.addSubnet(address, prefix, 'ipv6');
/** True for any address a plugin must not reach: loopback, private, link-local, CGNAT, documentation, multicast, IPv4-mapped. */
function privateAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 4) return blocked4.check(address, 'ipv4');
  if (/^::ffff:/i.test(address)) return true;
  return blocked6.check(address, 'ipv6');
}

/** Validates one request against the manifest. Returns the normalized request or throws a message for the plugin. */
function checkRequest(manifest, url, init = {}) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('请求地址无效。'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('只能使用 HTTPS 默认端口访问。');
  if (!(manifest.network || []).includes(u.hostname)) throw new Error(`插件没有声明访问 ${u.hostname}。`);
  if (!init || typeof init !== 'object' || Array.isArray(init)) throw new Error('请求参数无效。');
  const method = init.method === undefined ? 'GET' : String(init.method).toUpperCase();
  if (!METHODS.includes(method)) throw new Error('不支持的请求方法。');
  const headers = {};
  const source = init.headers === undefined ? {} : init.headers;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length > 32) throw new Error('请求头无效。');
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error('请求头无效。');
    if (FORBIDDEN_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('sec-')) continue;
    headers[key] = value;
  }
  let body = null;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body !== 'string') throw new Error('请求内容只能是文本，例如 JSON.stringify(...)。');
    if (method === 'GET') throw new Error('GET 请求不能带请求内容。');
    body = Buffer.from(init.body, 'utf8');
    if (body.length > MAX_REQUEST) throw new Error('请求内容不能超过 1 MB。');
  }
  return { url: u, method, headers, body, stream: init.stream === true };
}

/** Fills `{{secret:id}}` from the user's stored secrets. Only declared secret ids, only in header values. */
function fillSecrets(manifest, headers, read) {
  const declared = new Set((manifest.secrets || []).map(s => s.id)), out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value.replace(SECRET, (_all, id) => {
      if (!declared.has(id)) throw new Error('插件没有声明这个密钥。');
      const secret = read(id);
      if (!secret) throw new Error(`请先在 设置 → 插件 中填写「${manifest.secrets.find(s => s.id === id).label}」。`);
      return secret;
    });
  }
  return out;
}

/** dns.lookup that refuses private answers, so the connection itself can never reach them. */
function guardedLookup(lookup = dns.lookup) {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }]).filter(a => !privateAddress(a.address));
      if (!list.length) return callback(Object.assign(new Error('目标地址不允许访问。'), { code: 'PLUGIN_PRIVATE_ADDRESS' }));
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

class PluginNetwork {
  constructor(host, secrets, { request = https.request, lookup = dns.lookup, clock = Date.now } = {}) {
    Object.assign(this, { host, secrets, request, clock });
    this.lookup = guardedLookup(lookup);
    this.active = new Map(); // pluginId -> Set<ClientRequest>
    this.logs = new Map();   // pluginId -> recent requests (host, method, status, bytes), for the settings page
    this.stopped = false;
  }
  log(id, entry) {
    const list = this.logs.get(id) || [];
    list.push(entry); if (list.length > LOG) list.shift();
    this.logs.set(id, list);
  }
  register(plugin) {
    const h = this.host;
    h.ipcMain.handle('relink:plugin:fetch', (event, url, init, streamId) => {
      const r = plugin(event, 'any');
      if (!r || h.disposed || h.incident || this.stopped || !h.state.authenticated || !r.manifest.capabilities.includes('net.fetch')) throw new Error('未获授权的插件接口');
      const now = this.clock();
      r.fetchWindow = (r.fetchWindow || []).filter(at => now - at < 60000);
      if (r.fetchWindow.length >= PER_MINUTE) throw new Error('请求过于频繁，请稍后再试。');
      if ((this.active.get(r.manifest.id)?.size || 0) >= CONCURRENT) throw new Error('同时进行的请求太多。');
      const request = checkRequest(r.manifest, url, init);
      // Streamed chunks are addressed by an id the plugin's preload chose, so it can listen before the call returns.
      if (request.stream && (typeof streamId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(streamId))) throw new Error('流式请求标识无效。');
      const headers = fillSecrets(r.manifest, request.headers, id => this.secrets.read(r.manifest.id, id));
      r.fetchWindow.push(now);
      return this.run(r, event.sender, request, headers, request.stream ? streamId : randomUUID());
    });
    h.ipcMain.handle('relink:plugin:fetch-abort', (event, id) => {
      const r = plugin(event, 'any');
      if (!r) return;
      for (const req of this.active.get(r.manifest.id) || []) if (req.relinkId === id) req.destroy(new Error('请求已取消。'));
    });
    h.ipcMain.handle('relink:plugins:network-log', (event, id) => {
      if (!h.trustedIpc(event)) throw new Error('来源不允许。');
      return [...(this.logs.get(id) || [])].reverse();
    });
  }
  run(r, sender, { url, method, body, stream }, headers, id) {
    const pluginId = r.manifest.id;
    return new Promise((resolve, reject) => {
      let settled = false, bytes = 0;
      const chunks = [];
      const finish = (error, value) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        this.active.get(pluginId)?.delete(req);
        this.log(pluginId, { at: new Date(this.clock()).toISOString(), host: url.hostname, method, status: value?.status ?? 0, bytes, error: error ? error.message : '' });
        if (error) reject(error); else resolve(value);
      };
      const req = this.request({
        protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname + url.search, method,
        headers: { 'user-agent': `Relink-Plugin/${pluginId}`, ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
        lookup: this.lookup, agent: false, servername: url.hostname,
      }, response => {
        const status = response.statusCode || 0;
        const responseHeaders = {};
        for (const [key, value] of Object.entries(response.headers)) if (key !== 'set-cookie') responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
        if (stream && !sender.isDestroyed?.()) sender.send('relink:plugin:fetch-start', { id, status, headers: responseHeaders });
        response.setEncoding('utf8');
        response.on('data', text => {
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_RESPONSE) { req.destroy(new Error('响应内容超过 8 MB。')); return; }
          if (stream) { if (!sender.isDestroyed?.()) sender.send('relink:plugin:fetch-chunk', { id, text }); }
          else chunks.push(text);
        });
        response.on('end', () => finish(null, { id, status, headers: responseHeaders, ...(stream ? {} : { body: chunks.join('') }) }));
        response.on('error', error => finish(error));
      });
      req.relinkId = id;
      const timer = setTimeout(() => req.destroy(new Error('请求超时。')), TIMEOUT);
      timer.unref?.();
      if (!this.active.has(pluginId)) this.active.set(pluginId, new Set());
      this.active.get(pluginId).add(req);
      req.on('error', error => finish(error.code === 'PLUGIN_PRIVATE_ADDRESS' ? error : new Error(/^[一-鿿]/.test(error.message) ? error.message : '网络请求失败。')));
      req.end(body || undefined);
    });
  }
  /** Ends every request of one plugin (disabled, uninstalled or stopped). */
  abort(pluginId) { for (const req of this.active.get(pluginId) || []) req.destroy(new Error('插件已停止。')); this.active.delete(pluginId); }
  forget(pluginId) { this.abort(pluginId); this.logs.delete(pluginId); }
  stop() { this.stopped = true; for (const id of [...this.active.keys()]) this.abort(id); }
}

module.exports = { PluginNetwork, checkRequest, fillSecrets, guardedLookup, privateAddress };
