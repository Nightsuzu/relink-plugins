'use strict';
// Standalone development preview: mock state only, never connects to Relink.
//   node tools/preview.cjs <plugin folder>
//   /            desktop overlay (manifest.entry)
//   /panel       API v3 in-client panel
//   /background  API v4 background page, shown next to a mock text channel
// API v4 chat (events, edits, streamed answers, history), slash commands, voice events, notifications,
// storage and settings are simulated in the page. Edits apply at once here; Relink merges them to ~0.8 s.
// relinkPlugin.fetch is real: this server makes the request with the same checks as the client
// (declared HTTPS hosts only, never private addresses, {{secret:id}} only in header values).
// Secrets come from environment variables, e.g. RELINK_SECRET_DEEPSEEK=sk-... for the id "deepseek".
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectPackage, MAX_ASSET_BYTES, API_VERSIONS, PluginViolation, describeManifestError } = require('../runtime/package.cjs');
const { checkRequest, fillSecrets, guardedLookup } = require('../host/plugin-network.cjs');
const source = path.resolve(process.argv[2] || path.join(__dirname, '../examples/hello-relink'));
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const files = {};
const entries = fs.readdirSync(source).filter(file => !file.startsWith('.'));
if (entries.length > 33) throw new Error('At most 32 assets are supported.');
let size = 0;
for (const file of entries) {
  if (file === 'manifest.json') continue;
  const full = path.join(source, file), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_BYTES) throw new Error('Only flat regular assets up to 75 MiB are supported.');
  size += stat.size; if (size > MAX_ASSET_BYTES) throw new Error('Total assets exceed 75 MiB.');
  files[file] = fs.readFileSync(full).toString('base64');
}
let assets;
try { ({ assets } = inspectPackage(JSON.stringify({ format: 1, manifest, files }))); }
catch (error) {
  if (!(error instanceof PluginViolation)) throw error;
  console.error(`✗ ${describeManifestError(error.code, manifest)}（${error.code}）`);
  process.exit(1);
}
const has = cap => (manifest.capabilities || []).includes(cap);
const secretEnv = id => 'RELINK_SECRET_' + id.toUpperCase().replace(/-/g, '_');
const secretSet = Object.fromEntries((manifest.secrets || []).map(s => [s.id, Boolean(process.env[secretEnv(s.id)])]));
// Only the preview's own bridge may use the fetch relay; a page elsewhere in the browser cannot guess this.
const token = crypto.randomBytes(18).toString('base64url');

// Mock bridge injected into the page. API v3 parts (host info, participants, commands)
// are simulated too: three made-up people take turns speaking, and the preview toolbar
// presses the manifest's command buttons.
function mockBridge(manifest, surface, token, secretSet, apiVersions) {
  let state = { authenticated: true, connected: true, inVoice: true, roomName: '插件开发预览', memberCount: 3, muted: false, deafened: false, sharing: false };
  const listeners = new Set(), participantListeners = new Set(), commandListeners = new Set();
  const people = [{ id: 'p-preview-self', name: '预览用户', self: true }, { id: 'p-preview-01', name: '小雨' }, { id: 'p-preview-02', name: '晴天' }];
  let tick = 0;
  const participants = () => people.map((p, i) => ({ self: false, muted: i === 2 && tick % 7 === 0, deafened: false, ...p, speaking: (tick + i) % 3 === 0 }));
  if ((manifest.capabilities || []).includes('voice.participants')) setInterval(() => { tick++; for (const fn of participantListeners) fn(participants()); }, 700);
  const has = cap => (manifest.capabilities || []).includes(cap);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const denied = () => new Error('未获授权的插件接口');
  const clean = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : '';
  const windows = {};
  const limit = (key, count, ms) => { const now = Date.now(); const list = windows[key] = (windows[key] || []).filter(at => now - at < ms); if (list.length >= count) throw new Error('操作过于频繁，请稍后再试。'); list.push(now); };
  const subscribe = set => fn => { if (typeof fn !== 'function') return () => {}; set.add(fn); return () => set.delete(fn); };

  // In Relink a plugin page cannot connect anywhere by itself; the preview behaves the same.
  const relay = window.fetch.bind(window);
  const blocked = name => function () { throw new Error(`插件页面不能直接联网（${name}），请使用 relinkPlugin.fetch。`); };
  window.fetch = () => Promise.reject(new Error('插件页面不能直接联网，请使用 relinkPlugin.fetch。'));
  window.XMLHttpRequest = blocked('XMLHttpRequest'); window.WebSocket = blocked('WebSocket'); window.EventSource = blocked('EventSource');

  // Settings declared in the manifest, changed from the preview dock.
  const schema = manifest.settings || [];
  let settings = Object.fromEntries(schema.map(s => [s.key, s.default]));
  const settingsListeners = new Set();
  function applySettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('插件设置无效。');
    for (const [key, value] of Object.entries(patch)) {
      const s = schema.find(item => item.key === key);
      if (!s) throw new Error('未知的插件设置。');
      const text = typeof value === 'string' && [...value].length <= (s.maxLength ?? (s.type === 'text' ? 500 : 4000)) && !(s.type === 'text' ? /[\x00-\x1f\x7f]/ : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(value);
      const valid = s.type === 'toggle' ? typeof value === 'boolean' : s.type === 'range' ? Number.isSafeInteger(value) && value >= s.min && value <= s.max && (value - s.min) % s.step === 0
        : s.type === 'select' ? s.options.some(o => o.value === value) : text;
      if (!valid) throw new Error('插件设置超出允许范围。');
    }
    settings = { ...settings, ...patch };
    for (const fn of settingsListeners) fn({ ...settings });
    return { ...settings };
  }

  // API v4: a mock text channel. Messages ids and people ids are made up, like the per-plugin pseudonyms in Relink.
  const channel = { id: 'c-preview', name: '闲聊' };
  const chat = { policy: { read: true, send: true }, messages: [] };
  const chatListeners = new Set(), chatCommandListeners = new Set(), chatEventListeners = new Set(), voiceEventListeners = new Set();
  let seq = 0, render = () => {};
  const author = p => ({ id: 'u-' + p.id, name: p.name, self: p.self === true });
  const message = (person, text, extra = {}, at = new Date()) => ({ id: 'm-preview-' + (++seq), author: author(person), text, at: at.toISOString(), likes: 0, pinned: false, edited: false, pending: false, ...extra });
  function addMessage(person, text, extra = {}) {
    const m = message(person, text, extra);
    chat.messages.push(m);
    if (chat.messages.length > 50) chat.messages.shift();
    return m;
  }
  addMessage(people[1], '今晚开黑吗？'); addMessage(people[2], '可以，九点上线');
  // chat.history: a second channel with enough older messages to page through.
  const archive = { id: 'c-preview-guide', name: '攻略', messages: Array.from({ length: 80 }, (_, i) => message(people[1 + (i % 2)], `攻略第 ${i + 1} 条`, {}, new Date(Date.now() - (80 - i) * 60000))) };
  const canRead = () => has('chat.read') && chat.policy.read;
  function chatView() {
    return { available: canRead(), ...(has('chat.read') && !chat.policy.read ? { reason: '这个 Room 的域主没有允许插件读取消息。' } : {}), channel: { ...channel }, canSend: has('chat.send') && chat.policy.send, messages: canRead() ? clone(chat.messages) : [] };
  }
  function chatChanged(event) {
    const view = chatView(); for (const fn of chatListeners) fn(clone(view));
    if (event && canRead()) for (const fn of chatEventListeners) fn(clone(event));
    render();
  }
  function ownMessage(id) {
    const m = chat.messages.find(item => item.id === id && item.mine);
    if (!m) throw new Error('只能修改或撤回这个插件自己发的消息。');
    if (Date.now() - Date.parse(m.at) > 15 * 60 * 1000) throw new Error('消息发出超过 15 分钟，不能再修改。');
    return m;
  }
  const historyAllowed = () => {
    if (!has('chat.history') || !has('chat.read')) throw denied();
    limit('chat.history', 60, 60000);
    if (!chat.policy.read) throw new Error('这个 Room 的域主没有允许插件读取消息。');
  };

  // API v4: storage lives in this page and is gone after a refresh.
  const store = new Map();
  const bytes = text => new TextEncoder().encode(text).length;

  // API v4: relinkPlugin.fetch goes through the preview server, which applies the client's checks.
  const requests = new Map();
  async function proxy(url, init, onChunk) {
    if (!has('net.fetch')) throw denied();
    const { id: wanted, ...rest } = init && typeof init === 'object' ? init : {};
    const id = typeof wanted === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(wanted) ? wanted : crypto.randomUUID();
    const controller = new AbortController(); requests.set(id, controller);
    try {
      const response = await relay('/__relink/fetch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-relink-preview': token }, body: JSON.stringify({ url: String(url), init: rest }), signal: controller.signal });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', start = null, text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.error) throw new Error(message.error);
          if (message.start) start = message.start;
          if (typeof message.chunk === 'string') { if (onChunk) onChunk(message.chunk); else text += message.chunk; }
          if (message.end) return { id, status: start.status, headers: start.headers, ...(onChunk ? {} : { body: text }) };
        }
      }
      throw new Error('网络请求失败。');
    } catch (error) {
      if (controller.signal.aborted) throw new Error('请求已取消。');
      throw error;
    } finally { requests.delete(id); }
  }

  let toast = () => {};
  window.relinkPlugin = Object.freeze({
    getState: async () => ({ ...state }),
    onState: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    action: async name => { if (name === 'mute') state.muted = !state.muted; if (name === 'deafen') state.deafened = !state.deafened; if (name === 'expand' || name === 'collapse') document.body.classList.toggle('preview-expanded', name === 'expand'); for (const fn of listeners) fn({ ...state }); },
    getHostInfo: async () => ({ apiVersion: manifest.apiVersion, supportedApiVersions: [...apiVersions], client: 'preview', surface, capabilities: [...(manifest.capabilities || [])], commands: (manifest.commands || []).map(c => c.id), panel: Boolean(manifest.panel), developer: true,
      ...(manifest.apiVersion >= 4 ? { background: Boolean(manifest.background), network: [...(manifest.network || [])], secrets: (manifest.secrets || []).map(s => s.id), chatCommands: (manifest.chatCommands || []).map(c => c.name) } : {}) }),
    getParticipants: async () => { if (!has('voice.participants')) throw denied(); return participants(); },
    onParticipants: fn => { participantListeners.add(fn); return () => participantListeners.delete(fn); },
    onCommand: fn => { commandListeners.add(fn); return () => commandListeners.delete(fn); },
    getSettings: async () => ({ ...settings }),
    updateSettings: async patch => { limit('settings', 30, 10000); return applySettings(patch); },
    onSettings: subscribe(settingsListeners),
    // API v4
    fetch: async (url, init) => proxy(url, init, null),
    fetchStream: async (url, init, onChunk) => proxy(url, init, typeof onChunk === 'function' ? onChunk : () => {}),
    abortFetch: async id => { requests.get(id)?.abort(); },
    getSecretStatus: async () => { if (!has('secrets')) throw denied(); return { ...secretSet }; },
    getChat: async () => { if (!has('chat.read') && !has('chat.send')) throw denied(); return chatView(); },
    onChat: subscribe(chatListeners),
    onChatEvent: subscribe(chatEventListeners),
    sendChat: async value => {
      if (!has('chat.send')) throw denied();
      limit('chat.send', 20, 60000);
      if (!chat.policy.send) throw new Error('这个 Room 的域主没有允许插件发消息。');
      if (value?.format !== undefined && value.format !== 'markdown' && value.format !== 'text') throw new Error('消息格式只能是 text 或 markdown。');
      const pending = value?.pending === true;
      const text = clean(value?.text, 4000).trim() || (pending ? '…' : '');
      if (!text) throw new Error('消息需为 1 至 4000 个字符。');
      let replyTo;
      if (value?.replyTo !== undefined) {
        replyTo = chat.messages.find(m => m.id === value.replyTo)?.id;
        if (!replyTo || !has('chat.read')) throw new Error('要回复的消息不在当前频道。');
      }
      const m = addMessage(people[0], text, { ...(replyTo ? { replyTo } : {}), plugin: manifest.name, mine: true, pending, ...(value?.format === 'markdown' ? { format: 'markdown' } : {}) });
      chatChanged({ type: 'message', message: m });
      return { id: m.id };
    },
    editChat: async value => {
      if (!has('chat.send')) throw denied();
      limit('chat.edit', 6000, 60000);
      if (!chat.policy.send) throw new Error('这个 Room 的域主没有允许插件发消息。');
      const m = ownMessage(value?.id);
      if (value?.pending !== undefined && typeof value.pending !== 'boolean') throw new Error('pending 只能是 true 或 false。');
      const text = clean(value?.text, 4000).trim() || (value?.pending === true ? '…' : '');
      if (!text) throw new Error('消息需为 1 至 4000 个字符。');
      if (value?.pending === true && !m.pending) throw new Error('消息已经完成，不能再改回生成中。');
      // Updates while generating are not edits; a change after it finished is.
      if (!m.pending) m.edited = true;
      m.text = text; m.pending = value?.pending === true;
      chatChanged({ type: 'edit', message: m });
    },
    deleteChat: async id => {
      if (!has('chat.send')) throw denied();
      limit('chat.delete', 20, 60000);
      const m = ownMessage(id);
      chat.messages.splice(chat.messages.indexOf(m), 1);
      chatChanged({ type: 'withdraw', id: m.id });
    },
    getChatChannels: async () => { historyAllowed(); return [{ ...channel, current: true }, { id: archive.id, name: archive.name, current: false }]; },
    getChatHistory: async (query = {}) => {
      historyAllowed();
      const source = query.channelId === undefined || query.channelId === channel.id ? { ...channel, messages: chat.messages } : query.channelId === archive.id ? archive : null;
      if (!source) throw new Error('频道不存在，请先用 getChatChannels() 获取频道。');
      if (query.before !== undefined && (typeof query.before !== 'string' || Number.isNaN(Date.parse(query.before)))) throw new Error('before 需要是消息的 at 时间。');
      const max = query.limit === undefined ? 50 : query.limit;
      if (!Number.isSafeInteger(max) || max < 1 || max > 50) throw new Error('limit 需要是 1 到 50 的整数。');
      const earlier = source.messages.filter(m => !query.before || m.at < new Date(query.before).toISOString()), page = earlier.slice(-max);
      return { channel: { id: source.id, name: source.name }, messages: clone(page), hasMore: earlier.length > page.length };
    },
    onVoiceEvent: subscribe(voiceEventListeners),
    onChatCommand: subscribe(chatCommandListeners),
    notify: async value => {
      if (!has('notify')) throw denied();
      limit('notify', 6, 60000);
      const title = clean(value?.title, 40).trim(), body = clean(value?.body, 200).trim();
      if (!title) throw new Error('通知需要标题。');
      toast(`${manifest.name}：${title}`, body);
      return true;
    },
    storage: Object.freeze({
      get: async key => { if (!has('storage')) throw denied(); limit('storage', 120, 10000); if (typeof key !== 'string' || !key || key.length > 128) throw new Error('存储键无效。'); return store.has(key) ? JSON.parse(store.get(key)) : null; },
      set: async (key, value) => {
        if (!has('storage')) throw denied(); limit('storage', 120, 10000);
        if (typeof key !== 'string' || !key || key.length > 128) throw new Error('存储键无效。');
        let encoded; try { encoded = JSON.stringify(value); } catch { throw new Error('只能保存可以转成 JSON 的数据。'); }
        if (encoded === undefined) throw new Error('只能保存可以转成 JSON 的数据。');
        if (bytes(encoded) > 1024 * 1024) throw new Error('单项数据不能超过 1 MB。');
        let total = bytes(key) + bytes(encoded);
        for (const [k, v] of store) if (k !== key) total += bytes(k) + bytes(v);
        if (total > 5 * 1024 * 1024) throw new Error('插件存储空间已满（5 MB）。');
        store.set(key, encoded);
      },
      remove: async key => { if (!has('storage')) throw denied(); limit('storage', 120, 10000); if (typeof key !== 'string' || !key || key.length > 128) throw new Error('存储键无效。'); store.delete(key); },
      keys: async () => { if (!has('storage')) throw denied(); limit('storage', 120, 10000); return [...store.keys()]; },
    }),
  });

  addEventListener('DOMContentLoaded', () => {
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    if (manifest.commands?.length) {
      const bar = el('div', '__relink-preview-toolbar');
      bar.append('预览按钮：');
      for (const c of manifest.commands) { const b = el('button', '', c.title); b.type = 'button'; b.onclick = () => { for (const fn of commandListeners) fn({ id: c.id }); }; bar.append(b); }
      document.body.append(bar);
    }
    const toasts = el('div', '__relink-preview-toasts');
    document.body.append(toasts);
    toast = (title, body) => {
      const item = el('div', '__relink-preview-toast'); item.append(el('strong', '', title)); if (body) item.append(el('p', '', body));
      toasts.append(item); setTimeout(() => item.remove(), 6000);
    };
    const chatCaps = has('chat.read') || has('chat.send') || has('chat.commands');
    if (surface !== 'background' && !chatCaps && !schema.length) return;
    const dock = el('aside', '__relink-preview-dock' + (surface === 'background' ? ' is-background' : ''));
    if (surface === 'background') dock.append(el('p', '__relink-preview-note', '后台页面在 Relink 里没有窗口。这里是模拟频道：输入 /命令 交给插件，普通文字当作你发的消息。插件的 console 输出请看浏览器开发者工具。'));
    if (chatCaps) {
      dock.append(el('h2', '', `# ${channel.name}（模拟频道）`));
      const policy = el('div', '__relink-preview-policy');
      for (const [key, label] of [['read', '域主允许插件读取消息'], ['send', '域主允许插件发消息']]) {
        const row = el('label'), box = el('input'); box.type = 'checkbox'; box.checked = chat.policy[key];
        box.onchange = () => { chat.policy[key] = box.checked; chatChanged(); };
        row.append(box, label); policy.append(row);
      }
      dock.append(policy);
      const list = el('ol', '__relink-preview-messages');
      const form = el('form', '__relink-preview-composer'), input = el('input'), send = el('button', '', '发送'), other = el('button', '', '让别人说一句');
      input.placeholder = (manifest.chatCommands || []).length ? `输入消息，或 /${manifest.chatCommands[0].name} …` : '输入消息';
      other.type = 'button';
      const lines = ['有人在吗？', '刚刚那局打得不错', '明天几点集合？', '我先下了，晚安'];
      other.onclick = () => { chatChanged({ type: 'message', message: addMessage(people[1 + (seq % 2)], lines[seq % lines.length]) }); };
      const status = el('p', '__relink-preview-note');
      form.onsubmit = event => {
        event.preventDefault();
        const text = input.value.trim(); if (!text) return;
        input.value = ''; status.textContent = '';
        const command = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text);
        if (command) {
          const known = (manifest.chatCommands || []).some(c => c.name === command[1]);
          if (!has('chat.commands') || !known) { status.textContent = `没有 /${command[1]} 这个命令。${(manifest.chatCommands || []).length ? '可用：' + manifest.chatCommands.map(c => '/' + c.name).join(' ') : ''}`; return; }
          try { limit('chat.command', 5, 10000); } catch (error) { status.textContent = error.message; return; }
          status.textContent = `已把 /${command[1]} 交给插件（不会发到频道）。`;
          for (const fn of chatCommandListeners) fn({ name: command[1], args: clean(command[2] || '', 2000), channel: { ...channel } });
          return;
        }
        chatChanged({ type: 'message', message: addMessage(people[0], clean(text, 4000)) });
      };
      form.append(input, send, other);
      if (has('voice.participants') && manifest.apiVersion >= 4) {
        // voice.participants (v4): someone joins or leaves the voice channel.
        const guest = { id: 'p-preview-03', name: '路人甲' };
        let present = false;
        const voice = el('button', '', '模拟有人进出语音'); voice.type = 'button';
        voice.onclick = () => { present = !present; for (const fn of voiceEventListeners) fn({ type: present ? 'join' : 'leave', member: { id: guest.id, name: guest.name, self: false } }); status.textContent = `${guest.name}${present ? '加入' : '离开'}了语音频道（已推送 onVoiceEvent）。`; };
        form.append(voice);
      }
      dock.append(list, form, status);
      render = () => {
        list.replaceChildren(...chat.messages.map(m => {
          const item = el('li'), head = el('div', '__relink-preview-author', m.author.name);
          if (m.plugin) head.append(el('span', '__relink-preview-tag', `来自 ${m.plugin}`));
          if (m.format === 'markdown') head.append(el('span', '__relink-preview-tag', 'Markdown（客户端里会渲染）'));
          item.append(head, el('div', '', m.text));
          if (m.pending || m.edited) item.append(el('div', '__relink-preview-note', m.pending ? '正在生成…' : '已编辑'));
          return item;
        }));
        list.scrollTop = list.scrollHeight;
      };
      render();
    }
    if (schema.length) {
      dock.append(el('h2', '', '插件设置'));
      for (const s of schema) {
        const row = el('label', '__relink-preview-setting' + (s.type === 'textarea' ? ' is-textarea' : ''));
        const input = el(s.type === 'select' ? 'select' : s.type === 'textarea' ? 'textarea' : 'input');
        const report = fn => () => { try { fn(); } catch (error) { toast('设置没有保存', error.message); } };
        if (s.type === 'toggle') { input.type = 'checkbox'; input.checked = settings[s.key] === true; input.onchange = report(() => applySettings({ [s.key]: input.checked })); }
        else if (s.type === 'range') { Object.assign(input, { type: 'range', min: s.min, max: s.max, step: s.step, value: settings[s.key] }); input.onchange = report(() => applySettings({ [s.key]: Number(input.value) })); }
        else if (s.type === 'select') { for (const o of s.options) input.append(Object.assign(el('option', '', o.label), { value: o.value })); input.value = settings[s.key]; input.onchange = report(() => applySettings({ [s.key]: input.value })); }
        else { Object.assign(input, { value: settings[s.key], placeholder: s.placeholder || '', maxLength: s.maxLength ?? (s.type === 'text' ? 500 : 4000) }); if (s.type === 'textarea') input.rows = 4; input.onchange = report(() => applySettings({ [s.key]: input.value })); }
        row.append(el('span', '', s.label), input); dock.append(row);
      }
    }
    document.body.append(dock);
  });
}

const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
const PREVIEW_CSS = 'body{width:320px!important;margin:40px auto!important;background:#111319!important}body.preview-expanded{width:400px!important}body.preview-panel{width:340px!important;height:600px!important;background:#fbfbf9!important;outline:1px dashed #8884}body.preview-background{width:auto!important;min-height:100vh;margin:0!important}'
  + '.__relink-preview-toolbar{position:fixed;left:8px;bottom:8px;display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:8px;background:#000c;color:#fff;font:12px system-ui;z-index:2147483646}.__relink-preview-toolbar button{font:inherit}'
  + '.__relink-preview-dock{position:fixed;top:0;right:0;bottom:0;width:340px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px;background:#181b22;color:#e7ebe8;font:13px/1.6 system-ui;overflow:auto;z-index:2147483645;box-shadow:-1px 0 0 #ffffff14}'
  + '.__relink-preview-dock.is-background{left:0;width:min(640px,100%);margin:0 auto;box-shadow:none}.__relink-preview-dock h2{margin:6px 0 0;font-size:14px}.__relink-preview-note{margin:0;color:#a5ada9;font-size:12px}.__relink-preview-policy{display:grid;gap:2px;font-size:12px;color:#c8cfcb}.__relink-preview-policy input{margin-right:6px}'
  + '.__relink-preview-messages{flex:1;min-height:160px;margin:0;padding:8px;list-style:none;overflow:auto;border-radius:8px;background:#0f1116}.__relink-preview-messages li{margin-bottom:8px;white-space:pre-wrap;overflow-wrap:anywhere}'
  + '.__relink-preview-author{font-size:12px;color:#a5ada9}.__relink-preview-tag{margin-left:6px;padding:0 6px;border-radius:99px;background:#baf37e22;color:#c8edab;font-size:11px}'
  + '.__relink-preview-composer{display:flex;flex-wrap:wrap;gap:6px}.__relink-preview-composer input{flex:1;min-width:0;padding:6px 8px;border:1px solid #ffffff22;border-radius:6px;background:#0f1116;color:inherit;font:inherit}.__relink-preview-composer button{font:inherit}'
  + '.__relink-preview-setting{display:flex;justify-content:space-between;align-items:center;gap:12px}.__relink-preview-setting.is-textarea{flex-direction:column;align-items:stretch}.__relink-preview-setting select,.__relink-preview-setting input:not([type]),.__relink-preview-setting textarea{max-width:60%;padding:4px 6px;border:1px solid #ffffff22;border-radius:6px;background:#0f1116;color:inherit;font:inherit}.__relink-preview-setting textarea{max-width:none;resize:vertical}'
  + '.__relink-preview-toasts{position:fixed;top:12px;left:12px;display:grid;gap:8px;z-index:2147483647}.__relink-preview-toast{width:260px;padding:10px 12px;border-radius:8px;background:#000d;color:#fff;font:13px/1.5 system-ui}.__relink-preview-toast p{margin:4px 0 0;color:#cfd5d2}';
const pages = { '/': ['overlay', manifest.entry], '/panel': ['panel', manifest.panel?.entry], '/background': ['background', manifest.background] };

// Fetch relay: one request per call, answered as newline-separated JSON ({start}, {chunk}…, {end} or {error}).
let fetchWindow = [], active = 0;
function relayFetch(req, res) {
  if (req.method !== 'POST' || req.headers['x-relink-preview'] !== token) { res.writeHead(403).end(); return; }
  let raw = '', received = 0;
  req.setEncoding('utf8');
  req.on('data', chunk => { received += Buffer.byteLength(chunk); if (received > 2 * 1024 * 1024) req.destroy(); else raw += chunk; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = value => { if (!res.writableEnded) res.write(JSON.stringify(value) + '\n'); };
    let request, headers;
    try {
      if (!has('net.fetch')) throw new Error('未获授权的插件接口');
      const now = Date.now(); fetchWindow = fetchWindow.filter(at => now - at < 60000);
      if (fetchWindow.length >= 60) throw new Error('请求过于频繁，请稍后再试。');
      if (active >= 4) throw new Error('同时进行的请求太多。');
      const { url, init } = JSON.parse(raw);
      request = checkRequest(manifest, url, init);
      for (const value of Object.values(request.headers)) for (const [, id] of value.matchAll(/\{\{secret:([a-z][a-z0-9-]{1,31})\}\}/g)) {
        if ((manifest.secrets || []).some(s => s.id === id) && !process.env[secretEnv(id)]) throw new Error(`预览时请先设置环境变量 ${secretEnv(id)}，再重新启动预览。`);
      }
      headers = fillSecrets(manifest, request.headers, id => process.env[secretEnv(id)] || '');
      fetchWindow.push(now);
    } catch (error) { send({ error: error instanceof SyntaxError ? '请求参数无效。' : error.message }); res.end(); return; }
    active++;
    let bytes = 0, status = 0, done = false;
    const finish = error => {
      if (done) return; done = true; active--; clearTimeout(timer);
      send(error ? { error: error.message } : { end: true }); res.end();
      console.log(`[联网] ${request.method} ${request.url.hostname}${request.url.pathname} → ${error ? error.message : status}`);
    };
    const upstream = https.request({
      protocol: 'https:', hostname: request.url.hostname, port: 443, path: request.url.pathname + request.url.search, method: request.method,
      headers: { 'user-agent': `Relink-Plugin/${manifest.id} (preview)`, ...headers, ...(request.body ? { 'content-length': String(request.body.length) } : {}) },
      lookup: guardedLookup(), agent: false, servername: request.url.hostname,
    }, response => {
      status = response.statusCode || 0;
      const responseHeaders = {};
      for (const [key, value] of Object.entries(response.headers)) if (key !== 'set-cookie') responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
      send({ start: { status, headers: responseHeaders } });
      response.setEncoding('utf8');
      response.on('data', text => {
        bytes += Buffer.byteLength(text);
        if (bytes > 8 * 1024 * 1024) { upstream.destroy(new Error('响应内容超过 8 MB。')); return; }
        send({ chunk: text });
      });
      response.on('end', () => finish(null));
      response.on('error', finish);
    });
    const timer = setTimeout(() => upstream.destroy(new Error('请求超时。')), 120000);
    upstream.on('error', error => finish(error.code === 'PLUGIN_PRIVATE_ADDRESS' || /^[一-鿿]/.test(error.message) ? error : new Error('网络请求失败。')));
    res.on('close', () => { if (!done) upstream.destroy(new Error('请求已取消。')); });
    upstream.end(request.body || undefined);
  });
}

const server = http.createServer((req, res) => {
  // Only this address: a page on another site cannot reach the preview through a rebound DNS name.
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(421).end(); return; }
  const url = req.url.split('?')[0];
  if (url === '/__relink/fetch') { relayFetch(req, res); return; }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  // connect-src 'self' only so the bridge can reach the fetch relay; the bridge blocks the page's own fetch, like Relink.
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
  let body, type;
  const page = pages[url];
  const bridge = /^\/__preview-(overlay|panel|background)\.js$/.exec(url);
  if (bridge) { body = `(${mockBridge})(${JSON.stringify(manifest)}, ${JSON.stringify(bridge[1])}, ${JSON.stringify(token)}, ${JSON.stringify(secretSet)}, ${JSON.stringify(API_VERSIONS)});`; type = types.js; }
  else if (url === '/__preview.css') { body = PREVIEW_CSS; type = types.css; }
  else if (page && page[1] && assets.has(page[1])) {
    const [surface, file] = page, inject = `<script src="/__preview-${surface}.js"></script><link rel="stylesheet" href="/__preview.css">`;
    let html = assets.get(file).toString();
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${inject}`) : inject + html;
    if (surface !== 'overlay') html = html.replace(/<body([^>]*)>/i, `<body$1 class="preview-${surface}">`);
    body = Buffer.from(html); type = types.html;
  } else if (assets.has(url.slice(1))) { body = assets.get(url.slice(1)); type = types[url.split('.').pop()]; }
  else { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': type }); res.end(body);
});
server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Relink 插件预览（模拟数据，不连接 Relink）：${manifest.name} v${manifest.version} · API ${manifest.apiVersion}`);
  if (manifest.entry) console.log(`  浮层：${base}/`);
  if (manifest.panel) console.log(`  面板：${base}/panel`);
  if (manifest.background) console.log(`  后台页面（带模拟频道）：${base}/background`);
  if (manifest.network) console.log(`  联网：真实请求，只允许 ${manifest.network.join('、')}，检查规则和 Relink 相同`);
  for (const s of manifest.secrets || []) console.log(`  密钥「${s.label}」：环境变量 ${secretEnv(s.id)}（${secretSet[s.id] ? '已设置' : '未设置'}）`);
});
