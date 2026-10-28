'use strict';
// Plugin API v4: channel chat, slash commands, notifications and per-plugin storage.
// The trusted main window publishes the open text channel only while some enabled plugin may
// read it and the Room owner allows it; plugins see per-plugin pseudonymous ids, never account
// or message ids. Messages a plugin sends go through the window's normal send path with a
// visible "from plugin" label, so Room permissions, channel passwords and rate limits all apply.
// A plugin may rewrite or withdraw only the messages it sent itself (streamed answers); rewrites
// are merged here so a plugin cannot flood the server. `chat.history` (older messages and the
// Room's other text channels) is answered by the window on request, never pushed.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_MESSAGES = 50, MAX_TEXT = 4000, MAX_SEND = 4000, STORAGE_BYTES = 5 * 1024 * 1024, VALUE_BYTES = 1024 * 1024;
const EDIT_INTERVAL = 800, EDIT_WINDOW = 15 * 60 * 1000, SENT_LIMIT = 100, MAX_EVENTS = 50;
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : '';
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 160;

/** One message from the trusted renderer, bounded; null when malformed. */
function sanitizeMessage(m) {
  if (!m || !validKey(m.id) || !validKey(m.authorKey) || typeof m.at !== 'string' || Number.isNaN(Date.parse(m.at))) return null;
  return { id: m.id, authorKey: m.authorKey, authorName: clean(m.authorName, 64) || '成员', self: m.self === true, text: clean(m.text, MAX_TEXT), at: new Date(m.at).toISOString(),
    ...(validKey(m.replyTo) ? { replyTo: m.replyTo } : {}), ...(typeof m.via === 'string' && m.via ? { plugin: clean(m.via, 80) } : {}),
    ...(typeof m.viaId === 'string' && /^[a-z][a-z0-9-]{2,63}$/.test(m.viaId) ? { viaId: m.viaId } : {}),
    likes: Number.isSafeInteger(m.likes) && m.likes > 0 ? Math.min(m.likes, 100000) : 0, pinned: m.pinned === true, edited: m.edited === true, pending: m.pending === true,
    ...(m.format === 'markdown' ? { format: 'markdown' } : {}) };
}

/** Trusted renderer → bounded snapshot of the open text channel. */
function sanitizeChat(value) {
  if (!value || typeof value !== 'object' || !validKey(value.scope) || !value.channel || !validKey(value.channel.id)) return null;
  const policy = { read: value.policy?.read === true, send: value.policy?.send === true };
  const messages = (policy.read && Array.isArray(value.messages) ? value.messages : []).slice(-MAX_MESSAGES).map(sanitizeMessage).filter(Boolean);
  return { scope: value.scope, channel: { id: value.channel.id, name: clean(value.channel.name, 100) }, policy, canSend: value.canSend === true, messages };
}

/** What changed between two snapshots of the open channel, as events a plugin can react to without diffing. */
function chatEvents(prev, next) {
  if (!next) return prev ? [{ type: 'channel', channel: null }] : [];
  if (!prev || prev.scope !== next.scope || prev.channel.id !== next.channel.id) return [{ type: 'channel', channel: next.channel }];
  const before = new Map(prev.messages.map(m => [m.id, m])), after = new Set(next.messages.map(m => m.id)), events = [];
  for (const m of next.messages) {
    const old = before.get(m.id);
    if (!old) events.push({ type: 'message', message: m });
    else if (old.text !== m.text || old.pending !== m.pending || old.edited !== m.edited) events.push({ type: 'edit', message: m });
    else if (old.likes !== m.likes) events.push({ type: 'like', message: m });
    else if (old.pinned !== m.pinned) events.push({ type: 'pin', message: m });
  }
  // A message that left from after the first one still shown was withdrawn; the ones before it only scrolled out of the window.
  const firstKept = prev.messages.findIndex(m => after.has(m.id));
  prev.messages.forEach((m, i) => { if (firstKept >= 0 && i > firstKept && !after.has(m.id)) events.push({ type: 'withdraw', id: m.id }); });
  return events.slice(-MAX_EVENTS);
}

class PluginChat {
  constructor(host, { Notification } = {}) {
    this.host = host; this.Notification = Notification;
    this.chat = null; this.pending = new Map(); this.stores = new Map(); this.writes = new Map(); this.stopped = false;
    this.sent = new Map();   // pluginId -> Map(pseudonymous id -> { id, at, scope }) of messages that plugin sent
    this.edits = new Map();  // real message id -> merged rewrite waiting to go out
    this.channelIds = new Map(); // pluginId -> Map(pseudonymous channel id -> real id) from what it was shown
    this.storageRoot = path.join(host.root, 'storage');
  }
  id(r, kind, key) { return kind + this.host.v3.pseudonym(r.manifest.id, kind + key); }
  /** One message as a plugin sees it: pseudonymous ids, and whether this plugin sent it. */
  messageFor(r, m) {
    return { id: this.id(r, 'm', m.id), author: { id: this.id(r, 'u', m.authorKey), name: m.authorName, self: m.self }, text: m.text, at: m.at,
      ...(m.replyTo ? { replyTo: this.id(r, 'm', m.replyTo) } : {}), ...(m.plugin ? { plugin: m.plugin } : {}),
      ...(m.self && m.viaId === r.manifest.id ? { mine: true } : {}),
      likes: m.likes || 0, pinned: m.pinned === true, edited: m.edited === true, pending: m.pending === true, ...(m.format ? { format: m.format } : {}) };
  }
  channelFor(r, channel) {
    const id = this.id(r, 'c', channel.id), map = this.channelIds.get(r.manifest.id) || new Map();
    map.set(id, channel.id); if (map.size > 200) map.delete(map.keys().next().value);
    this.channelIds.set(r.manifest.id, map);
    return { id, name: channel.name };
  }
  canRead(r) { return r.manifest.capabilities.includes('chat.read') && this.chat?.policy.read === true; }
  /** What one plugin may see of the open channel. */
  viewFor(r) {
    const c = this.chat, caps = r.manifest.capabilities;
    if (!this.host.state.authenticated || !this.host.state.connected || !c) return { available: false, reason: '没有打开文字频道。', channel: null, canSend: false, messages: [] };
    const canRead = caps.includes('chat.read') && c.policy.read;
    const canSend = caps.includes('chat.send') && c.policy.send && c.canSend;
    return {
      available: canRead,
      ...(caps.includes('chat.read') && !c.policy.read ? { reason: '这个 Room 的域主没有允许插件读取消息。' } : {}),
      channel: this.channelFor(r, c.channel),
      canSend,
      messages: canRead ? c.messages.map(m => this.messageFor(r, m)) : [],
    };
  }
  interested(r) { return ['chat.read', 'chat.send'].some(c => r.manifest.capabilities.includes(c)); }
  broadcast(prev) {
    const events = prev === undefined ? [] : chatEvents(prev, this.chat);
    for (const r of this.host.records.values()) {
      if (!this.interested(r)) continue;
      this.host.send(r, 'relink:plugin:chat', this.viewFor(r));
      // Message events only for plugins that may read; a channel switch is visible to senders too.
      const own = events.filter(e => e.type === 'channel' || this.canRead(r)).map(e => e.type === 'channel' ? { type: 'channel', channel: e.channel ? this.channelFor(r, e.channel) : null }
        : e.type === 'withdraw' ? { type: 'withdraw', id: this.id(r, 'm', e.id) } : { type: e.type, message: this.messageFor(r, e.message) });
      for (const e of own) this.host.send(r, 'relink:plugin:chat-event', e);
    }
  }
  /** Asks the trusted window to do something in the open Room (send, edit, withdraw, read history); resolves with its answer. */
  ask(op, fields, timeout = 10000) {
    const w = this.host.getWindow();
    if (!w || w.isDestroyed()) return Promise.reject(new Error('主窗口不可用。'));
    if (this.pending.size >= 16) return Promise.reject(new Error('正在处理，请稍候。'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(op === 'send' ? '消息未能确认发送，请返回 Relink 查看。' : '操作未能确认，请稍后再试。')); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      w.webContents.send('relink:plugins:chat-send', { requestId, op, ...fields });
    });
  }
  /** The real id of a message this plugin sent, if it may still rewrite it. */
  ownMessage(r, id) {
    const entry = typeof id === 'string' ? this.sent.get(r.manifest.id)?.get(id) : null;
    if (!entry) throw new Error('只能修改或撤回这个插件自己发的消息。');
    if (Date.now() - entry.at > EDIT_WINDOW) throw new Error('消息发出超过 15 分钟，不能再修改。');
    return entry;
  }
  /** Rewrites go out at most every 0.8 seconds per message; the newest text wins and every caller learns the outcome. */
  edit(r, entry, text, pending) {
    let e = this.edits.get(entry.id);
    if (!e) { e = { waiters: [], last: 0, timer: null, inflight: false }; this.edits.set(entry.id, e); }
    e.text = text; e.pending = pending;
    const flush = () => {
      e.timer = null; e.inflight = true; e.last = Date.now();
      const waiters = e.waiters; e.waiters = [];
      this.ask('edit', { scope: entry.scope, messageId: entry.id, pluginId: r.manifest.id, text: e.text, ...(e.pending ? { pending: true } : {}) })
        .then(() => waiters.forEach(w => w.resolve()), error => waiters.forEach(w => w.reject(error)))
        .finally(() => { e.inflight = false; if (e.waiters.length) schedule(); else if (this.edits.get(entry.id) === e) this.edits.delete(entry.id); });
    };
    const schedule = () => { if (e.timer || e.inflight) return; e.timer = setTimeout(flush, Math.max(0, e.last + EDIT_INTERVAL - Date.now())); };
    return new Promise((resolve, reject) => { e.waiters.push({ resolve, reject }); schedule(); });
  }
  storeFile(id) { return path.join(this.storageRoot, `${id}.json`); }
  async store(id) {
    if (this.stores.has(id)) return this.stores.get(id);
    let data = {};
    try { const raw = JSON.parse(await fs.readFile(this.storeFile(id), 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) data = raw; }
    catch (error) { if (error.code !== 'ENOENT') data = {}; }
    this.stores.set(id, data);
    return data;
  }
  async persist(id) {
    const data = this.stores.get(id) || {};
    const write = (this.writes.get(id) || Promise.resolve()).then(async () => {
      await fs.mkdir(this.storageRoot, { recursive: true });
      const file = this.storeFile(id), tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file);
    });
    this.writes.set(id, write.catch(() => {}));
    return write;
  }
  async forget(id) {
    this.stores.delete(id);
    await (this.writes.get(id) || Promise.resolve());
    await fs.unlink(this.storeFile(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  register(plugin) {
    const h = this.host;
    const allow = (event, cap, limit) => {
      const r = plugin(event, 'any');
      if (!r || h.disposed || h.incident || this.stopped || !h.state.authenticated || !r.manifest.capabilities.includes(cap)) throw new Error('未获授权的插件接口');
      if (limit) { const now = Date.now(), key = 'v4' + (limit.key || cap); r[key] = (r[key] || []).filter(at => now - at < limit.window); if (r[key].length >= limit.count) throw new Error('操作过于频繁，请稍后再试。'); r[key].push(now); }
      return r;
    };
    // Window → host: the open text channel (or nothing).
    h.ipcMain.on('relink:plugins:chat', (event, value) => {
      if (!h.trustedIpc(event) || h.incident || h.disposed) return;
      const next = sanitizeChat(value);
      if (JSON.stringify(next) === JSON.stringify(this.chat)) return;
      const prev = this.chat;
      this.chat = next; this.broadcast(prev);
    });
    h.ipcMain.handle('relink:plugin:chat', event => {
      const r = plugin(event, 'any');
      if (!r || h.disposed || h.incident || !h.state.authenticated || !this.interested(r)) throw new Error('未获授权的插件接口');
      return this.viewFor(r);
    });
    h.ipcMain.handle('relink:plugin:chat-send', async (event, value) => {
      const r = allow(event, 'chat.send', { count: 20, window: 60000 });
      const c = this.chat;
      if (!c || !c.policy.send || !c.canSend) throw new Error(c && !c.policy.send ? '这个 Room 的域主没有允许插件发消息。' : '当前频道不能发送消息。');
      const pending = value?.pending === true;
      if (value?.format !== undefined && value.format !== 'markdown' && value.format !== 'text') throw new Error('消息格式只能是 text 或 markdown。');
      // A streamed answer may start empty; it shows as "generating" until the plugin finishes it.
      const text = clean(value?.text, MAX_SEND).trim() || (pending ? '…' : '');
      if (!text) throw new Error('消息需为 1 至 4000 个字符。');
      let replyTo;
      if (value?.replyTo !== undefined) {
        replyTo = c.messages.find(m => this.id(r, 'm', m.id) === value.replyTo)?.id;
        if (!replyTo || !r.manifest.capabilities.includes('chat.read')) throw new Error('要回复的消息不在当前频道。');
      }
      const result = await this.ask('send', { scope: c.scope, channelId: c.channel.id, text, ...(replyTo ? { replyTo } : {}), ...(value?.format === 'markdown' ? { format: 'markdown' } : {}), ...(pending ? { pending: true } : {}),
        via: { pluginId: r.manifest.id, name: r.manifest.name } });
      if (!validKey(result?.messageId)) return {};
      const id = this.id(r, 'm', result.messageId), sent = this.sent.get(r.manifest.id) || new Map();
      sent.set(id, { id: result.messageId, at: Date.now(), scope: c.scope });
      if (sent.size > SENT_LIMIT) sent.delete(sent.keys().next().value);
      this.sent.set(r.manifest.id, sent);
      return { id };
    });
    // API v4: rewrite (e.g. a streamed answer) or withdraw a message this plugin sent, within 15 minutes.
    h.ipcMain.handle('relink:plugin:chat-edit', async (event, value) => {
      const r = allow(event, 'chat.send', { count: 6000, window: 60000, key: 'chat.edit' }); // merged below, so a token-by-token stream is fine
      const entry = this.ownMessage(r, value?.id);
      if (value?.pending !== undefined && typeof value.pending !== 'boolean') throw new Error('pending 只能是 true 或 false。');
      const text = clean(value?.text, MAX_SEND).trim() || (value?.pending === true ? '…' : '');
      if (!text) throw new Error('消息需为 1 至 4000 个字符。');
      await this.edit(r, entry, text, value?.pending === true);
    });
    h.ipcMain.handle('relink:plugin:chat-delete', async (event, id) => {
      const r = allow(event, 'chat.send', { count: 20, window: 60000, key: 'chat.delete' });
      const entry = this.ownMessage(r, id);
      await this.ask('withdraw', { scope: entry.scope, messageId: entry.id, pluginId: r.manifest.id });
      this.sent.get(r.manifest.id)?.delete(id);
    });
    // API v4 `chat.history`: the Room's other text channels and older messages, answered by the window on request.
    const history = event => {
      const r = allow(event, 'chat.history', { count: 60, window: 60000 });
      if (!r.manifest.capabilities.includes('chat.read')) throw new Error('未获授权的插件接口');
      const c = this.chat;
      if (!c) throw new Error('没有打开 Room 的文字频道。');
      if (!c.policy.read) throw new Error('这个 Room 的域主没有允许插件读取消息。');
      return { r, c };
    };
    h.ipcMain.handle('relink:plugin:chat-channels', async event => {
      const { r, c } = history(event);
      const answer = await this.ask('channels', { scope: c.scope });
      const list = Array.isArray(answer?.channels) ? answer.channels.slice(0, 100) : [];
      return list.filter(ch => validKey(ch?.id)).map(ch => ({ ...this.channelFor(r, { id: ch.id, name: clean(ch.name, 100) }), current: ch.id === c.channel.id }));
    });
    h.ipcMain.handle('relink:plugin:chat-history', async (event, query) => {
      const { r, c } = history(event);
      const channelId = query?.channelId === undefined ? c.channel.id : this.channelIds.get(r.manifest.id)?.get(query.channelId);
      if (!channelId) throw new Error('频道不存在，请先用 getChatChannels() 获取频道。');
      if (query?.before !== undefined && (typeof query.before !== 'string' || Number.isNaN(Date.parse(query.before)))) throw new Error('before 需要是消息的 at 时间。');
      const limit = query?.limit === undefined ? 50 : query.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('limit 需要是 1 到 50 的整数。');
      const answer = await this.ask('history', { scope: c.scope, channelId, ...(query?.before ? { before: new Date(query.before).toISOString() } : {}), limit });
      const messages = (Array.isArray(answer?.messages) ? answer.messages.slice(-limit) : []).map(sanitizeMessage).filter(Boolean);
      return { channel: this.channelFor(r, { id: channelId, name: clean(answer?.channelName, 100) }), messages: messages.map(m => this.messageFor(r, m)), hasMore: answer?.hasMore === true };
    });
    h.ipcMain.on('relink:plugins:chat-result', (event, value) => {
      if (!h.trustedIpc(event)) return;
      const p = this.pending.get(value?.requestId); if (!p) return;
      this.pending.delete(value.requestId); clearTimeout(p.timer);
      value.ok === true ? p.resolve(value) : p.reject(new Error(clean(value.error, 120) || '消息未发送。'));
    });
    // Window → plugin: a slash command the user typed. The text never reaches the channel.
    h.ipcMain.handle('relink:plugins:chat-command', async (event, id, name, args) => {
      if (!h.trustedIpc(event)) throw new Error('来源不允许。');
      if (h.incident || h.disposed) throw new Error('插件模块已停止。');
      const r = typeof id === 'string' ? h.records.get(id) : null;
      if (!r || !h.pref(id).enabled || !r.manifest.capabilities.includes('chat.commands') || !(r.manifest.chatCommands || []).some(c => c.name === name)) throw new Error('插件命令不可用。');
      if (!h.surfaces(r).length) throw new Error('插件没有在运行，请先在 设置 → 插件 中开启它。');
      const now = Date.now(); r.chatCommandWindow = (r.chatCommandWindow || []).filter(at => now - at < 10000);
      if (r.chatCommandWindow.length >= 5) throw new Error('操作过于频繁。');
      r.chatCommandWindow.push(now);
      const c = this.chat;
      h.send(r, 'relink:plugin:chat-command', { name, args: clean(args, MAX_SEND), channel: c ? { id: this.id(r, 'c', c.channel.id), name: c.channel.name } : null });
    });
    h.ipcMain.handle('relink:plugin:notify', (event, value) => {
      const r = allow(event, 'notify', { count: 6, window: 60000 });
      const title = clean(value?.title, 40).trim(), body = clean(value?.body, 200).trim();
      if (!title) throw new Error('通知需要标题。');
      if (!this.Notification?.isSupported?.()) return false;
      new this.Notification({ title: `${r.manifest.name}：${title}`, body, silent: value?.silent === true }).show();
      return true;
    });
    h.ipcMain.handle('relink:plugin:storage', async (event, op, key, value) => {
      const r = allow(event, 'storage', { count: 120, window: 10000 });
      const id = r.manifest.id, data = await this.store(id);
      if (op === 'keys') return Object.keys(data);
      if (typeof key !== 'string' || !key || key.length > 128) throw new Error('存储键无效。');
      if (op === 'get') return Object.hasOwn(data, key) ? JSON.parse(data[key]) : null;
      if (op === 'remove') { if (Object.hasOwn(data, key)) { delete data[key]; await this.persist(id); } return; }
      if (op !== 'set') throw new Error('存储操作无效。');
      let encoded;
      try { encoded = JSON.stringify(value); } catch { throw new Error('只能保存可以转成 JSON 的数据。'); }
      if (encoded === undefined) throw new Error('只能保存可以转成 JSON 的数据。');
      if (Buffer.byteLength(encoded) > VALUE_BYTES) throw new Error('单项数据不能超过 1 MB。');
      const total = Object.entries(data).reduce((sum, [k, v]) => k === key ? sum : sum + Buffer.byteLength(k) + Buffer.byteLength(v), 0) + Buffer.byteLength(key) + Buffer.byteLength(encoded);
      if (total > STORAGE_BYTES) throw new Error('插件存储空间已满（5 MB）。');
      data[key] = encoded; await this.persist(id);
    });
  }
  /** Uninstall: forget which messages the plugin sent and which channels it was shown. */
  forgetPlugin(pluginId) { this.sent.delete(pluginId); this.channelIds.delete(pluginId); }
  stop() {
    this.stopped = true; this.chat = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('插件已停止。')); }
    this.pending.clear();
    for (const e of this.edits.values()) clearTimeout(e.timer);
    this.edits.clear();
  }
}

module.exports = { PluginChat, sanitizeChat, chatEvents };
