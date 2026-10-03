'use strict';
const { PluginViolation } = require('../runtime/package.cjs');
const ACTION_CAPABILITY = { mute: 'voice.mute', deafen: 'voice.deafen', show: 'app.show', expand: 'window.resize', collapse: 'window.resize' };
function sanitizeState(value = {}) {
  return {
    authenticated: value.authenticated === true,
    connected: value.connected === true,
    inVoice: value.inVoice === true,
    roomName: typeof value.roomName === 'string' ? value.roomName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '',
    memberCount: Number.isSafeInteger(value.memberCount) ? Math.max(0, Math.min(100000, value.memberCount)) : 0,
    muted: value.muted === true, deafened: value.deafened === true,
    sharing: value.sharing === true,
  };
}
function allowedAsset(url, id, assets) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'relink-plugin:' || u.hostname !== id || u.search || u.hash || u.username || u.password || u.port) return null;
    const name = u.pathname.slice(1);
    return assets.has(name) ? name : null;
  } catch { return null; }
}
function actionPolicy(value, capabilities, state) {
  if (typeof value !== 'string' || !Object.hasOwn(ACTION_CAPABILITY, value) || !capabilities.includes(ACTION_CAPABILITY[value])) throw new PluginViolation('capability');
  if (!state.authenticated || (['mute', 'deafen'].includes(value) && (!state.inVoice || !state.connected))) return false;
  return true;
}
function limiter(limit = 8, clock = Date.now) {
  let start = clock(), count = 0;
  return () => { const now = clock(); if (now - start >= 1000) { start = now; count = 0; } return ++count <= limit; };
}
module.exports = { sanitizeState, allowedAsset, actionPolicy, limiter };
