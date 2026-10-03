'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeState, allowedAsset, actionPolicy, limiter } = require('../host/plugin-policy.cjs');
const { verifyPackage, PluginViolation } = require('../runtime/package.cjs');
test('host only exposes the documented non-secret display state', () => {
  const state = sanitizeState({ authenticated: true, token: 'private', account: { id: 'private' }, messages: [], roomName: 'Room\n', memberCount: Infinity });
  assert.deepEqual(Object.keys(state).sort(), ['authenticated', 'connected', 'inVoice', 'roomName', 'memberCount', 'muted', 'deafened', 'sharing'].sort());
  assert.equal(state.roomName, 'Room'); assert.equal(state.memberCount, 0);
});
test('network, foreign origins and alternate asset representations are denied', () => {
  const files = new Map([['index.html', Buffer.alloc(0)]]);
  assert.equal(allowedAsset('relink-plugin://test-island/index.html', 'test-island', files), 'index.html');
  for (const url of ['https://example.com/index.html', 'file:///index.html', 'relink-plugin://other/index.html', 'relink-plugin://test-island/index.html?x=1', 'relink-plugin://test-island/%69ndex.html']) assert.equal(allowedAsset(url, 'test-island', files), null);
});
test('controls require both permission and a current authenticated voice state', () => {
  const state = sanitizeState({ authenticated: true, connected: true, inVoice: true });
  assert.equal(actionPolicy('mute', ['voice.mute'], state), true);
  assert.equal(actionPolicy('mute', ['voice.mute'], { ...state, inVoice: false }), false);
  assert.equal(actionPolicy('show', ['app.show'], { ...state, authenticated: false }), false);
  assert.throws(() => actionPolicy('mute', [], state), PluginViolation);
  assert.throws(() => actionPolicy('spawn', [], state), PluginViolation);
});
test('one plugin cannot flood host controls without bounds', () => {
  let now = 0; const allow = limiter(8, () => now);
  for (let i = 0; i < 8; i++) assert.equal(allow(), true);
  assert.equal(allow(), false); now = 1000; assert.equal(allow(), true);
});
test('the published official example is signed and identical to its source assets', () => {
  const item = verifyPackage(fs.readFileSync(path.join(__dirname, '../host/relink-island.rlplugin')), require('../host/plugin-authority.json'));
  for (const [name, bytes] of item.assets) assert.deepEqual(bytes, fs.readFileSync(path.join(__dirname, '../examples/island', name)));
  assert.deepEqual(item.manifest, JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/island/manifest.json'))));
});
