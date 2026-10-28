'use strict';
const crypto = require('node:crypto');
// Limits apply to the complete .rlplugin file, including its authorization.
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ASSET_BYTES = Math.floor(MAX_BYTES * 3 / 4);
const AUTHORIZATION_RESERVE = 1024;
const CAPABILITIES = ['voice.read', 'voice.mute', 'voice.deafen', 'app.show', 'window.resize', 'music.read', 'music.control', 'music.lyrics', 'channels.read', 'channels.switch', 'voice.participants', 'net.fetch', 'secrets', 'chat.read', 'chat.send', 'chat.commands', 'chat.history', 'notify', 'storage'];
/** API versions this runtime can validate. v3 adds participants, commands, an in-client panel and host info;
 *  v4 adds declared-host network access, user secrets, channel chat, slash commands, notifications, storage and a background page. */
const API_VERSIONS = [1, 2, 3, 4];
/** Capabilities that need API v3 (older manifests cannot ask for them). */
const V3_CAPABILITIES = ['voice.participants'];
/** Capabilities that need API v4. */
const V4_CAPABILITIES = ['net.fetch', 'secrets', 'chat.read', 'chat.send', 'chat.commands', 'chat.history', 'notify', 'storage'];
/** A public DNS name a plugin may reach over HTTPS: no IP literals, no single-label or local names. */
function validNetworkHost(host) {
  if (typeof host !== 'string' || host.length > 253 || host !== host.toLowerCase()) return false;
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(l => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  if (/^\d+$/.test(labels[labels.length - 1])) return false;
  return !['localhost', 'local', 'internal', 'lan', 'home', 'corp', 'intranet', 'arpa'].includes(labels[labels.length - 1]);
}
/** Plain-language explanation for each manifest/package check, shown to plugin authors. */
const MANIFEST_ERRORS = {
  'package-size': '插件包超过 100 MB。',
  'package-fields': '插件包里有不认识的字段。',
  'package-format': '插件包格式版本不对，请用 SDK 的 tools/pack.cjs 重新打包。',
  'files': '插件包的文件列表无效，请用 SDK 的 tools/pack.cjs 重新打包。',
  'asset-encoding': '资源文件编码损坏，请用 SDK 的 tools/pack.cjs 重新打包。',
  'package-json': 'manifest.json 不是有效的 JSON。',
  'manifest-fields': 'manifest.json 里有不认识的字段。允许的字段：id、name、version、apiVersion、entry、description、capabilities、author、settings、commands、panel、background、network、secrets、chatCommands。',
  'plugin-id': 'id 只能用小写字母、数字和连字符，以字母开头，3–64 个字符。',
  'plugin-version': 'version 需要是 1.2.3 这样的三段数字。',
  'api-version': 'apiVersion 需要是 1 到 1000 的整数，并且和所用功能匹配：voice.participants、commands 和 panel 需要 "apiVersion": 3；联网、密钥、聊天、命令、通知、存储和 background 需要 "apiVersion": 4。',
  'background': 'background 必须指向一个 .html 资源，并且不能和 entry、panel.entry 相同。',
  'network': 'net.fetch 和 network 必须一起声明：network 是 1–8 个小写的公网域名（如 api.deepseek.com），不能是 IP、localhost 或内网名称。',
  'secrets': 'secrets 权限和 secrets 字段必须一起声明（1–4 项），并且需要同时声明 net.fetch。',
  'secret-fields': '每个密钥只允许 id 和 label 两个字段。',
  'secret-id': '密钥 id 只能用小写字母、数字和连字符（2–32 个字符），且不能重复。',
  'secret-label': '密钥 label 不能为空，最多 40 个字。',
  'chat-commands': 'chat.commands 权限和 chatCommands 字段必须一起声明（1–8 个命令）。',
  'chat-history': 'chat.history（读取更早的消息和 Room 里的其他文字频道）需要同时声明 chat.read。',
  'chat-command-fields': '每个聊天命令只允许 name 和 description 两个字段。',
  'chat-command-name': '命令 name 只能用小写字母、数字和连字符，以字母开头，最多 24 个字符，且不能重复。',
  'chat-command-description': '命令 description 不能为空，最多 40 个字。',
  'manifest-text': 'name 不能为空且不超过 80 字，description 不超过 300 字。',
  'capabilities': 'capabilities 里有重复或不存在的权限。',
  'file-count': '插件需要至少 1 个、最多 32 个资源文件。',
  'asset-path': '资源文件名只能用字母、数字、_ 和 -，扩展名限 html/js/css/svg/png/webp，不能有子文件夹。',
  'assets-size': '资源总大小超出限制。',
  'entry': 'entry 必须指向一个 .html 资源（v3 插件只有面板时可以省略）。',
  'panel-fields': 'panel 只允许 entry 和 title 两个字段。',
  'panel-entry': 'panel.entry 必须是一个 .html 资源，并且不能和桌面浮窗 entry 相同。',
  'panel-title': 'panel.title 不能为空，最多 12 个字。',
  'commands': 'commands 需要 1–4 个按钮。',
  'command-fields': '每个按钮只允许 id、title、icon 三个字段。',
  'command-id': '按钮 id 只能用小写字母、数字和连字符（2–32 个字符），且不能重复。',
  'command-title': '按钮 title 不能为空，最多 16 个字。',
  'command-icon': '按钮 icon 必须是不超过 16 KB 的 .svg 资源。',
  'author-fields': 'author 只允许 name 和 avatar。',
  'author-name': 'author.name 不能为空，最多 80 字。',
  'author-avatar': 'author.avatar 必须是不超过 200 KB 的 png/webp 资源。',
  'settings-schema': 'settings 最多 12 项。',
  'setting-fields': '设置项只允许 key、label、type、default，以及对应类型的 min、max、step（range）、placeholder、maxLength（text / textarea）、options（select）。',
  'setting-key': '设置项 key 需以小写字母开头，label 不能为空且不超过 60 字，key 不能重复。',
  'setting-toggle': '开关类设置的 default 必须是 true/false，不能带其他类型的字段。',
  'setting-range': '滑条类设置需要整数 min/max/step/default，范围 0–1000，default 落在步长上。',
  'setting-text': 'text 设置的 default 是文字（不超过 maxLength），maxLength 是 1–500 的整数（textarea 为 1–4000），placeholder 最多 60 字；text 不能换行。需要 "apiVersion": 4。',
  'setting-select': 'select 设置需要 2–20 个 options，每项是 { "value": "…", "label": "…" }，value 最多 64 字且不重复，label 最多 40 字，default 必须是其中一个 value。需要 "apiVersion": 4。',
  'setting-type': '设置项 type 只能是 toggle、range、text、textarea 或 select。',
};
/** Explains a check failure; with the manifest at hand it also names the offending values. */
function describeManifestError(code, manifest) {
  const base = MANIFEST_ERRORS[code] || `未知的检查项（${code}）。`;
  const m = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  if (!m) return base;
  const list = values => values.map(v => JSON.stringify(v)).join('、');
  let detail = '';
  if (code === 'manifest-fields') {
    const allowed = ['id', 'name', 'version', 'apiVersion', 'entry', 'description', 'capabilities', 'author', 'settings', 'commands', 'panel', 'background', 'network', 'secrets', 'chatCommands'];
    const unknown = Object.keys(m).filter(k => !allowed.includes(k));
    if (unknown.length) detail = `不认识的字段：${list(unknown)}。`;
  } else if (code === 'capabilities' && Array.isArray(m.capabilities)) {
    const unknown = m.capabilities.filter(c => !CAPABILITIES.includes(c)), repeated = m.capabilities.filter((c, i) => m.capabilities.indexOf(c) !== i);
    detail = [unknown.length && `不存在的权限：${list(unknown)}`, repeated.length && `重复的权限：${list(repeated)}`].filter(Boolean).join('；');
    if (detail) detail += `。可用的权限：${CAPABILITIES.join('、')}。`;
  } else if (code === 'api-version' && Number.isSafeInteger(m.apiVersion)) {
    const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
    const v4 = [...caps.filter(c => V4_CAPABILITIES.includes(c)), ...['background', 'network', 'secrets', 'chatCommands'].filter(k => m[k] !== undefined)];
    const v3 = [...caps.filter(c => V3_CAPABILITIES.includes(c)), ...['commands', 'panel'].filter(k => m[k] !== undefined)];
    if (m.apiVersion < 4 && v4.length) detail = `现在写的是 "apiVersion": ${m.apiVersion}，但用到了 ${list(v4)}，请改成 4。`;
    else if (m.apiVersion < 3 && v3.length) detail = `现在写的是 "apiVersion": ${m.apiVersion}，但用到了 ${list(v3)}，请改成 3 或更高。`;
  } else if (code === 'network') {
    const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
    if (caps.includes('net.fetch') && m.network === undefined) detail = '声明了 net.fetch，但没有写 network 域名列表。';
    else if (!caps.includes('net.fetch') && m.network !== undefined) detail = '写了 network，但 capabilities 里没有 net.fetch。';
    else if (Array.isArray(m.network)) { const bad = m.network.filter(h => !validNetworkHost(h)); if (bad.length) detail = `这些域名不能用：${list(bad)}。只写域名本身，不要带 https:// 或路径。`; }
  } else if (code === 'secrets' || code === 'chat-commands') {
    const caps = Array.isArray(m.capabilities) ? m.capabilities : [], [cap, field] = code === 'secrets' ? ['secrets', 'secrets'] : ['chat.commands', 'chatCommands'];
    if (caps.includes(cap) && m[field] === undefined) detail = `声明了 ${cap}，但没有写 ${field}。`;
    else if (!caps.includes(cap) && m[field] !== undefined) detail = `写了 ${field}，但 capabilities 里没有 ${cap}。`;
    else if (code === 'secrets' && !caps.includes('net.fetch')) detail = '密钥只能用在联网请求里，请同时声明 net.fetch。';
  } else if (['entry', 'background', 'panel-entry'].includes(code)) {
    const file = code === 'entry' ? m.entry : code === 'background' ? m.background : m.panel?.entry;
    detail = file === undefined ? '没有填写这个字段。' : `现在写的是 ${JSON.stringify(file)}，请确认文件在插件文件夹里，并且文件名只有字母、数字、_ 和 -。`;
  }
  return detail ? `${base}${detail}` : base;
}
class PluginViolation extends Error {
  constructor(code) { super(`插件授权校验失败：${code}`); this.name = 'PluginViolation'; this.code = code; }
}
const fail = code => { throw new PluginViolation(code); };
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function exact(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail(code);
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inspectPackage(input) {
  const bytes = typeof input === 'string' || Buffer.isBuffer(input) ? input : Buffer.from(input);
  if ((typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length) > MAX_BYTES) fail('package-size');
  let pkg; try { pkg = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8')); } catch { fail('package-json'); }
  exact(pkg, ['format', 'manifest', 'files', 'authorization'], 'package-fields');
  if (pkg.format !== 1) fail('package-format');
  const m = pkg.manifest;
  exact(m, ['id', 'name', 'version', 'apiVersion', 'entry', 'description', 'capabilities', 'author', 'settings', 'commands', 'panel', 'background', 'network', 'secrets', 'chatCommands'], 'manifest-fields');
  if (typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(m.id)) fail('plugin-id');
  if (typeof m.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(m.version)) fail('plugin-version');
  if (!Number.isSafeInteger(m.apiVersion) || m.apiVersion < 1 || m.apiVersion > 1000) fail('api-version');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80 || typeof m.description !== 'string' || m.description.length > 300) fail('manifest-text');
  if (!Array.isArray(m.capabilities) || new Set(m.capabilities).size !== m.capabilities.length || m.capabilities.some(c => !CAPABILITIES.includes(c))) fail('capabilities');
  if (m.apiVersion < 3 && (m.capabilities.some(c => V3_CAPABILITIES.includes(c)) || m.commands !== undefined || m.panel !== undefined)) fail('api-version');
  if (m.apiVersion < 4 && (m.capabilities.some(c => V4_CAPABILITIES.includes(c)) || ['background', 'network', 'secrets', 'chatCommands'].some(k => m[k] !== undefined))) fail('api-version');
  // Each v4 declaration goes with its capability, so the install prompt can name exactly what is reached and stored.
  const has = c => m.capabilities.includes(c);
  if (has('net.fetch') !== (m.network !== undefined)) fail('network');
  if (m.network !== undefined && (!Array.isArray(m.network) || !m.network.length || m.network.length > 8 || new Set(m.network).size !== m.network.length || !m.network.every(validNetworkHost))) fail('network');
  if (has('secrets') !== (m.secrets !== undefined)) fail('secrets');
  if (m.secrets !== undefined) {
    if (!Array.isArray(m.secrets) || !m.secrets.length || m.secrets.length > 4) fail('secrets');
    const ids = new Set();
    for (const s of m.secrets) {
      exact(s, ['id', 'label'], 'secret-fields');
      if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(s.id) || ids.has(s.id)) fail('secret-id');
      ids.add(s.id);
      if (typeof s.label !== 'string' || !s.label.trim() || [...s.label].length > 40 || /[\x00-\x1f]/.test(s.label)) fail('secret-label');
    }
    if (!has('net.fetch')) fail('secrets');
  }
  if (has('chat.history') && !has('chat.read')) fail('chat-history');
  if (has('chat.commands') !== (m.chatCommands !== undefined)) fail('chat-commands');
  if (m.chatCommands !== undefined) {
    if (!Array.isArray(m.chatCommands) || !m.chatCommands.length || m.chatCommands.length > 8) fail('chat-commands');
    const names = new Set();
    for (const c of m.chatCommands) {
      exact(c, ['name', 'description'], 'chat-command-fields');
      if (typeof c.name !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(c.name) || names.has(c.name)) fail('chat-command-name');
      names.add(c.name);
      if (typeof c.description !== 'string' || !c.description.trim() || [...c.description].length > 40 || /[\x00-\x1f]/.test(c.description)) fail('chat-command-description');
    }
  }
  exact(pkg.files, Object.keys(pkg.files || {}), 'files');
  const paths = Object.keys(pkg.files);
  if (!paths.length || paths.length > 32) fail('file-count');
  const seen = new Set(), assets = new Map(), hashes = {};
  let size = 0;
  for (const file of paths.sort()) {
    // Flat assets only: no archives, symlinks or traversal.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(html|js|css|svg|png|webp)$/.test(file) || seen.has(file.toLowerCase())) fail('asset-path');
    seen.add(file.toLowerCase());
    const encoded = pkg.files[file];
    // A repeated capture over a large base64 string can exhaust the regexp
    // stack. Validate characters and the final padding with bounded patterns.
    if (typeof encoded !== 'string' || encoded.length > MAX_BYTES || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) fail('asset-encoding');
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.indexOf('=') !== (padding ? encoded.length - padding : -1)) fail('asset-encoding');
    const decoded = Buffer.from(encoded, 'base64');
    size += decoded.length;
    if (size > MAX_ASSET_BYTES) fail('assets-size');
    assets.set(file, decoded); hashes[file] = digest(decoded);
  }
  // From API v3 a plugin may live only in its panel; `entry` (the desktop overlay) is then optional.
  const page = file => typeof file === 'string' && file.endsWith('.html') && assets.has(file);
  if (m.entry !== undefined || m.apiVersion < 3 || (m.panel === undefined && m.background === undefined)) { if (!page(m.entry)) fail('entry'); }
  // API v4: an invisible page that runs while the plugin is enabled (for chat commands and assistants without a window).
  if (m.background !== undefined && (!page(m.background) || m.background === m.entry || m.background === m.panel?.entry)) fail('background');
  if (m.panel !== undefined) {
    exact(m.panel, ['entry', 'title'], 'panel-fields');
    if (!page(m.panel.entry) || m.panel.entry === m.entry) fail('panel-entry');
    if (typeof m.panel.title !== 'string' || !m.panel.title.trim() || [...m.panel.title].length > 12 || /[\x00-\x1f]/.test(m.panel.title)) fail('panel-title');
  }
  if (m.commands !== undefined) {
    // Buttons in the call controls' plugin menu. The plugin hears which one was pressed, nothing more.
    if (!Array.isArray(m.commands) || !m.commands.length || m.commands.length > 4) fail('commands');
    const ids = new Set();
    for (const c of m.commands) {
      exact(c, ['id', 'title', 'icon'], 'command-fields');
      if (typeof c.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(c.id) || ids.has(c.id)) fail('command-id');
      ids.add(c.id);
      if (typeof c.title !== 'string' || !c.title.trim() || [...c.title].length > 16 || /[\x00-\x1f]/.test(c.title)) fail('command-title');
      if (c.icon !== undefined && (!/\.svg$/.test(c.icon) || !assets.has(c.icon) || assets.get(c.icon).length > 16384)) fail('command-icon');
    }
  }
  if(m.author!==undefined){
    exact(m.author,['name','avatar'],'author-fields');
    if(typeof m.author.name!=='string'||!m.author.name.trim()||m.author.name.length>80)fail('author-name');
    if(m.author.avatar!==undefined&&(!/\.(png|webp)$/.test(m.author.avatar)||!assets.has(m.author.avatar)||assets.get(m.author.avatar).length>200000))fail('author-avatar');
  }
  if(m.settings!==undefined){
    if(!Array.isArray(m.settings)||m.settings.length>12)fail('settings-schema');
    const keys=new Set();
    for(const s of m.settings){
      exact(s,['key','label','type','default','min','max','step','placeholder','maxLength','options'],'setting-fields');
      if(typeof s.key!=='string'||!/^[a-z][a-zA-Z0-9]{0,39}$/.test(s.key)||['constructor','prototype'].includes(s.key)||keys.has(s.key)||typeof s.label!=='string'||!s.label.trim()||s.label.length>60)fail('setting-key');
      keys.add(s.key);
      // Fields that belong to other setting types are mistakes, not extras.
      const only=allowed=>['min','max','step','placeholder','maxLength','options'].some(k=>!allowed.includes(k)&&Object.hasOwn(s,k));
      if(s.type==='toggle'){if(typeof s.default!=='boolean'||only([]))fail('setting-toggle');}
      else if(s.type==='range'){if(only(['min','max','step'])||![s.min,s.max,s.step,s.default].every(Number.isSafeInteger)||s.min<0||s.max>1000||s.min>=s.max||s.step<1||s.default<s.min||s.default>s.max||(s.default-s.min)%s.step)fail('setting-range');}
      else if(s.type==='text'||s.type==='textarea'){
        // API v4: free text the plugin reads as is (prompts, model names). Not for keys: use `secrets`.
        if(m.apiVersion<4)fail('api-version');
        const limit=s.type==='text'?500:4000;
        if(only(['placeholder','maxLength'])||(s.maxLength!==undefined&&(!Number.isSafeInteger(s.maxLength)||s.maxLength<1||s.maxLength>limit))||(s.placeholder!==undefined&&(typeof s.placeholder!=='string'||[...s.placeholder].length>60||/[\x00-\x1f]/.test(s.placeholder)))||!validSettingText(s,s.default))fail('setting-text');
      }
      else if(s.type==='select'){
        if(m.apiVersion<4)fail('api-version');
        if(only(['options'])||!Array.isArray(s.options)||s.options.length<2||s.options.length>20)fail('setting-select');
        const values=new Set();
        for(const o of s.options){
          exact(o,['value','label'],'setting-select');
          if(typeof o.value!=='string'||!o.value||[...o.value].length>64||/[\x00-\x1f]/.test(o.value)||values.has(o.value)||typeof o.label!=='string'||!o.label.trim()||[...o.label].length>40||/[\x00-\x1f]/.test(o.label))fail('setting-select');
          values.add(o.value);
        }
        if(!values.has(s.default))fail('setting-select');
      }
      else fail('setting-type');
    }
  }
  const contentHash = digest(Buffer.from(canonical({ format: 1, manifest: m, hashes })));
  return { pkg, manifest: m, assets, contentHash, packageHash: digest(bytes), size };
}
function verifyAuthorization(record, authority, { now = Date.now() } = {}) {
  const inspected = record, a = record.authorization;
  exact(a, ['keyId', 'pluginId', 'version', 'contentHash', 'issuedAt', 'expiresAt', 'signature'], 'authorization-fields');
  if (a.pluginId !== inspected.manifest.id || a.version !== inspected.manifest.version || a.contentHash !== inspected.contentHash) fail('authorization-binding');
  if (typeof a.keyId !== 'string' || !Object.hasOwn(authority.keys || {}, a.keyId)) fail('unknown-issuer');
  if (!Number.isSafeInteger(a.issuedAt) || !Number.isSafeInteger(a.expiresAt) || a.issuedAt < 0 || a.expiresAt < 0 || a.issuedAt > now + 300000 || (a.expiresAt !== 0 && (a.expiresAt <= now || a.expiresAt <= a.issuedAt))) fail('authorization-time');
  if ((authority.revoked || []).some(item => item === inspected.contentHash || item === `${a.pluginId}@${a.version}` || item === `key:${a.keyId}`)) fail('revoked');
  if (typeof a.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(a.signature)) fail('signature-format');
  const { signature, ...payload } = a;
  let valid = false; try { valid = crypto.verify(null, Buffer.from(canonical(payload)), authority.keys[a.keyId], Buffer.from(signature, 'base64')); } catch { /* Fail closed. */ }
  if (!valid) fail('signature');
}
function verifyPackage(input, authority, options) {
  const inspected = inspectPackage(input);
  verifyAuthorization({ ...inspected, authorization: inspected.pkg.authorization }, authority, options);
  return inspected;
}
function runtimePackage(inspected) {
  // The decoded assets are sufficient for serving the plugin. Do not retain
  // a second, base64-encoded copy of every asset in long-lived host records.
  const { pkg, ...record } = inspected;
  return { ...record, authorization: { ...pkg.authorization } };
}
function authorizePackage(input, privateKey, keyId, { issuedAt = Date.now(), expiresAt = 0, expectedContentHash } = {}) {
  const { pkg, manifest, contentHash } = inspectPackage(input);
  if (expectedContentHash !== undefined && expectedContentHash !== contentHash) fail('authorization-binding');
  const payload = { keyId, pluginId: manifest.id, version: manifest.version, contentHash, issuedAt, expiresAt };
  pkg.authorization = { ...payload, signature: crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') };
  const bytes = Buffer.from(JSON.stringify(pkg));
  if (bytes.length > MAX_BYTES) fail('package-size');
  return bytes;
}
/** Text settings: a string within maxLength; single-line text has no line breaks, neither has control characters. */
function validSettingText(s, v) {
  if(typeof v!=='string'||[...v].length>(s.maxLength??(s.type==='text'?500:4000)))return false;
  return s.type==='text'?!/[\x00-\x1f\x7f]/.test(v):!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
}
function validSetting(s, v) {
  if(s.type==='toggle')return typeof v==='boolean';
  if(s.type==='range')return Number.isSafeInteger(v)&&v>=s.min&&v<=s.max&&(v-s.min)%s.step===0;
  if(s.type==='select')return typeof v==='string'&&s.options.some(o=>o.value===v);
  return validSettingText(s,v);
}
function pluginSettings(manifest, saved={}, patch={}) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('插件设置无效。');
  const schema=manifest.settings||[],result={};
  if(Object.keys(patch).some(k=>!schema.some(s=>s.key===k)))throw Error('未知的插件设置。');
  for(const s of schema){
    const valid=v=>validSetting(s,v);
    if(Object.hasOwn(patch,s.key)&&!valid(patch[s.key]))throw Error('插件设置超出允许范围。');
    result[s.key]=Object.hasOwn(patch,s.key)?patch[s.key]:valid(saved?.[s.key])?saved[s.key]:s.default;
  }return result;
}
module.exports = { MAX_BYTES, MAX_ASSET_BYTES, AUTHORIZATION_RESERVE, CAPABILITIES, API_VERSIONS, V3_CAPABILITIES, V4_CAPABILITIES, validNetworkHost, MANIFEST_ERRORS, describeManifestError, PluginViolation, canonical, digest, inspectPackage, verifyPackage, verifyAuthorization, runtimePackage, authorizePackage, pluginSettings };
