'use strict';
// Plugin API v3: host information, voice participants, command buttons and the
// in-client panel. Everything here keeps the v1/v2 rules: plugins have no network,
// no account identifiers, no message content and no audio; the trusted main window
// decides what is published and where a panel may appear.
const { createHmac, randomBytes } = require('node:crypto');
const { API_VERSIONS } = require('../runtime/package.cjs');
const { limiter } = require('./plugin-policy.cjs');

const MAX_PARTICIPANTS = 50;
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';

/** Trusted renderer → bounded list. Keys are the client's member ids; they never reach a plugin. */
function sanitizeParticipants(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(), out = [];
  for (const item of value.slice(0, MAX_PARTICIPANTS)) {
    if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 160 || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push({ key: item.key, name: clean(item.name, 64) || '成员', self: item.self === true, speaking: item.speaking === true, muted: item.muted === true, deafened: item.deafened === true });
  }
  return out;
}

/** Main-window coordinates for a panel. Anything outside the window, fractional or tiny is refused. */
function sanitizeBounds(value, size) {
  if (!value || typeof value !== 'object') return null;
  const b = {};
  for (const k of ['x', 'y', 'width', 'height']) { if (!Number.isFinite(value[k])) return null; b[k] = Math.round(value[k]); }
  if (b.width < 160 || b.height < 120 || b.x < 0 || b.y < 0) return null;
  if (size && (b.x + b.width > size.width + 1 || b.y + b.height > size.height + 1)) return null;
  return b;
}

/** Join/leave between two member lists. Entering or leaving a call yourself is one event about you, not one per member. */
function voiceEvents(prev, next) {
  const before = new Set(prev.map(p => p.key)), after = new Set(next.map(p => p.key));
  if (!prev.length || !next.length) {
    const self = (next.length ? next : prev).find(p => p.self);
    return self ? [{ type: next.length ? 'join' : 'leave', member: self }] : [];
  }
  return [...next.filter(p => !before.has(p.key)).map(member => ({ type: 'join', member })), ...prev.filter(p => !after.has(p.key)).map(member => ({ type: 'leave', member }))].slice(0, 50);
}

class PluginV3 {
  constructor(host) {
    this.host = host;
    // Per-run secret: pseudonymous ids are stable while Relink runs, differ per plugin, and cannot be joined back to accounts.
    this.secret = randomBytes(32);
    this.participants = [];
  }
  pseudonym(pluginId, key) { return createHmac('sha256', this.secret).update(pluginId + '\0' + key).digest('base64url').slice(0, 16); }
  participantsFor(r) {
    if (!this.host.state.inVoice || !this.host.state.connected) return [];
    return this.participants.map(({ key, ...rest }) => ({ id: this.pseudonym(r.manifest.id, key), ...rest }));
  }
  hostInfo(r, kind) {
    return {
      apiVersion: r.manifest.apiVersion,
      supportedApiVersions: [...API_VERSIONS],
      client: typeof this.host.app.getVersion === 'function' ? this.host.app.getVersion() : '',
      surface: kind,
      capabilities: [...r.manifest.capabilities],
      commands: (r.manifest.commands || []).map(c => c.id),
      panel: Boolean(r.manifest.panel),
      developer: r.dev === true,
      // API v4 fields only for v4 plugins; earlier plugins keep the exact v3 shape.
      ...(r.manifest.apiVersion >= 4 ? {
        background: Boolean(r.manifest.background),
        network: [...(r.manifest.network || [])],
        secrets: (r.manifest.secrets || []).map(s => s.id),
        chatCommands: (r.manifest.chatCommands || []).map(c => c.name),
      } : {}),
    };
  }
  register(plugin) {
    const h = this.host;
    h.ipcMain.handle('relink:plugin:host-info', event => {
      const found = plugin(event, 'any');
      if (!found || h.incident || h.disposed) throw new Error('来源不允许。');
      return this.hostInfo(found, h.surfaceOf(found, event));
    });
    h.ipcMain.handle('relink:plugin:participants', event => {
      const r = plugin(event, 'any');
      if (!r || h.incident || h.disposed || !h.state.authenticated || !r.manifest.capabilities.includes('voice.participants')) throw new Error('未获授权的插件接口');
      r.participantsLimit ||= limiter(24);
      if (!r.participantsLimit()) throw new Error('操作过于频繁');
      return this.participantsFor(r);
    });
    h.ipcMain.on('relink:plugins:participants', (event, value) => {
      if (!h.trustedIpc(event) || h.incident || h.disposed) return;
      const next = sanitizeParticipants(value);
      if (JSON.stringify(next) === JSON.stringify(this.participants)) return;
      const prev = this.participants;
      this.participants = next;
      this.broadcastParticipants();
      this.broadcastVoiceEvents(voiceEvents(prev, next));
    });
    h.ipcMain.handle('relink:plugins:command', async (event, id, command) => {
      if (!h.trustedIpc(event)) throw new Error('来源不允许。');
      if (h.incident || h.disposed) throw new Error('插件模块已停止。');
      const r = typeof id === 'string' ? h.records.get(id) : null;
      if (!r || !h.pref(id).enabled || !(r.manifest.commands || []).some(c => c.id === command)) throw new Error('插件按钮不可用。');
      if (!h.surfaces(r).length) throw new Error('插件没有在运行，请先打开它。');
      r.commandLimit ||= limiter(8);
      if (!r.commandLimit()) throw new Error('操作过于频繁。');
      h.send(r, 'relink:plugin:command', { id: command });
    });
    h.ipcMain.handle('relink:plugins:panel', async (event, id, bounds) => {
      if (!h.trustedIpc(event)) throw new Error('来源不允许。');
      if (h.incident || h.disposed) throw new Error('插件模块已停止。');
      return h.serializePanel(() => this.placePanel(id, bounds));
    });
  }
  /** API v4: who joined or left the voice channel, so plugins need not diff the member list. */
  broadcastVoiceEvents(events) {
    if (!events.length) return;
    for (const r of this.host.records.values()) {
      if (r.manifest.apiVersion < 4 || !r.manifest.capabilities.includes('voice.participants')) continue;
      for (const e of events) this.host.send(r, 'relink:plugin:voice-event', { type: e.type, member: { id: this.pseudonym(r.manifest.id, e.member.key), name: e.member.name, self: e.member.self } });
    }
  }
  broadcastParticipants() {
    for (const r of this.host.records.values()) {
      if (r.manifest.capabilities.includes('voice.participants')) this.host.send(r, 'relink:plugin:participants', this.participantsFor(r));
    }
  }
  /** Shows, moves or hides one plugin's panel. Only the trusted window calls this; plugins cannot move themselves. */
  async placePanel(id, value) {
    const h = this.host;
    // One panel at a time: showing a plugin's panel hides every other one.
    for (const other of h.records.values()) if (other.panel && other.manifest.id !== id) h.closePanel(other);
    const r = typeof id === 'string' ? h.records.get(id) : null;
    if (!r) return { visible: false };
    const main = h.getWindow();
    const size = main && !main.isDestroyed() && main.getContentBounds ? main.getContentBounds() : null;
    const bounds = value === null ? null : sanitizeBounds(value, size);
    if (!bounds || !r.manifest.panel || !h.pref(id).enabled || !h.state.authenticated || r.removed || r.error) { h.closePanel(r); return { visible: false }; }
    if (!API_VERSIONS.includes(r.manifest.apiVersion)) { h.closePanel(r); return { visible: false, error: '此插件需要更新版本的 Relink。' }; }
    if (r.panel?.view) { r.panel.view.setBounds(bounds); return { visible: true }; }
    await h.openPanel(r, bounds);
    return { visible: Boolean(r.panel?.view) };
  }
  stop() { this.participants = []; }
}

module.exports = { voiceEvents, PluginV3, sanitizeParticipants, sanitizeBounds };
