'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { authorizePackage, verifyPackage, inspectPackage, PluginViolation } = require('../runtime/package.cjs');
const pair = crypto.generateKeyPairSync('ed25519');
const authority = { keys: { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) }, revoked: [] };
function unsigned(patch = {}) {
  return JSON.stringify({ format: 1, manifest: { id: 'test-island', name: 'Test', version: '1.0.0', apiVersion: 1, entry: 'index.html', description: '', capabilities: ['voice.read'], ...patch }, files: { 'index.html': Buffer.from('<html></html>').toString('base64') } });
}
function signed(input = unsigned(), options) { return authorizePackage(input, pair.privateKey, 'test', options); }
function reject(bytes, expected, keys = authority, options) { assert.throws(() => verifyPackage(bytes, keys, options), e => e instanceof PluginViolation && e.code === expected); }
test('signed exact-content approval succeeds and never returns private keys', () => {
  const p = verifyPackage(signed(), authority); assert.equal(p.manifest.id, 'test-island'); assert.equal(p.assets.get('index.html').toString(), '<html></html>'); assert.equal(p.pkg.privateKey, undefined);
});
test('unsigned packages are rejected before execution', () => reject(unsigned(), 'authorization-fields'));
test('asset tampering, extra files and manifest permission changes invalidate approval', () => {
  for (const mutate of [p => { p.files['index.html'] = Buffer.from('changed').toString('base64'); }, p => { p.files['extra.js'] = Buffer.from('extra').toString('base64'); }, p => { p.manifest.capabilities.push('app.show'); }, p => { p.manifest.entry = 'other.html'; p.files['other.html'] = p.files['index.html']; }]) {
    const p = JSON.parse(signed()); mutate(p); reject(JSON.stringify(p), 'authorization-binding');
  }
});
test('identity and version cannot replay another release authorization', () => {
  for (const key of ['id', 'version']) { const p = JSON.parse(signed()); p.manifest[key] = key === 'id' ? 'other-island' : '1.0.1'; reject(JSON.stringify(p), 'authorization-binding'); }
});
test('unknown authority, forged signature, expiry, future approval and revocation fail closed', () => {
  const bytes = signed(); reject(bytes, 'unknown-issuer', { keys: {} });
  const p = JSON.parse(bytes); p.authorization.signature = Buffer.alloc(64).toString('base64'); reject(JSON.stringify(p), 'signature');
  reject(signed(unsigned(), { issuedAt: 1000, expiresAt: 2000 }), 'authorization-time', authority, { now: 3000 });
  reject(signed(unsigned(), { issuedAt: 9999999 }), 'authorization-time', authority, { now: 3000 });
  const { contentHash } = inspectPackage(bytes);
  for (const revoked of [contentHash, 'test-island@1.0.0', 'key:test']) reject(bytes, 'revoked', { ...authority, revoked: [revoked] });
});
test('unsupported API can retain valid authorization for host compatibility handling', () => assert.equal(verifyPackage(signed(unsigned({ apiVersion: 2 })), authority).manifest.apiVersion, 2));
test('traversal, case collisions and unsupported script types are rejected', () => {
  for (const file of ['../evil.js', 'a/b.js', '%2e%2e.js', 'payload.cjs', 'index.HTML', 'INDEX.html']) {
    const p = JSON.parse(unsigned()); p.files[file] = p.files['index.html']; assert.throws(() => inspectPackage(JSON.stringify(p)), PluginViolation);
  }
});
test('malformed assets, oversized packages and unknown capabilities cannot be packed', () => {
  const p = JSON.parse(unsigned()); p.files['index.html'] = '!not-base64'; assert.throws(() => inspectPackage(JSON.stringify(p)), PluginViolation);
  assert.throws(() => inspectPackage(Buffer.alloc(2097153)), PluginViolation);
  assert.throws(() => inspectPackage(unsigned({ capabilities: ['filesystem.write'] })), PluginViolation);
});
