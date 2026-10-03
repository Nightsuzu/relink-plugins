'use strict';
const crypto = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
const CAPABILITIES = ['voice.read', 'voice.mute', 'voice.deafen', 'app.show', 'window.resize'];
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
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > MAX_BYTES) fail('package-size');
  let pkg; try { pkg = JSON.parse(bytes.toString('utf8')); } catch { fail('package-json'); }
  exact(pkg, ['format', 'manifest', 'files', 'authorization'], 'package-fields');
  if (pkg.format !== 1) fail('package-format');
  const m = pkg.manifest;
  exact(m, ['id', 'name', 'version', 'apiVersion', 'entry', 'description', 'capabilities'], 'manifest-fields');
  if (typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(m.id)) fail('plugin-id');
  if (typeof m.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(m.version)) fail('plugin-version');
  if (!Number.isSafeInteger(m.apiVersion) || m.apiVersion < 1 || m.apiVersion > 1000) fail('api-version');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80 || typeof m.description !== 'string' || m.description.length > 300) fail('manifest-text');
  if (!Array.isArray(m.capabilities) || new Set(m.capabilities).size !== m.capabilities.length || m.capabilities.some(c => !CAPABILITIES.includes(c))) fail('capabilities');
  exact(pkg.files, Object.keys(pkg.files || {}), 'files');
  const paths = Object.keys(pkg.files);
  if (!paths.length || paths.length > 32) fail('file-count');
  const seen = new Set(), assets = new Map(), hashes = {};
  let size = 0;
  for (const file of paths.sort()) {
    // A flat, deliberately small asset format: no archives, symlinks or traversal.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(html|js|css|svg|png|webp)$/.test(file) || seen.has(file.toLowerCase())) fail('asset-path');
    seen.add(file.toLowerCase());
    const encoded = pkg.files[file];
    if (typeof encoded !== 'string' || encoded.length > MAX_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('asset-encoding');
    const decoded = Buffer.from(encoded, 'base64');
    size += decoded.length;
    if (size > MAX_BYTES / 2) fail('assets-size');
    assets.set(file, decoded); hashes[file] = digest(decoded);
  }
  if (typeof m.entry !== 'string' || !m.entry.endsWith('.html') || !assets.has(m.entry)) fail('entry');
  const contentHash = digest(Buffer.from(canonical({ format: 1, manifest: m, hashes })));
  return { pkg, manifest: m, assets, contentHash, packageHash: digest(bytes), size };
}
function verifyPackage(input, authority, { now = Date.now() } = {}) {
  const inspected = inspectPackage(input), a = inspected.pkg.authorization;
  exact(a, ['keyId', 'pluginId', 'version', 'contentHash', 'issuedAt', 'expiresAt', 'signature'], 'authorization-fields');
  if (a.pluginId !== inspected.manifest.id || a.version !== inspected.manifest.version || a.contentHash !== inspected.contentHash) fail('authorization-binding');
  if (typeof a.keyId !== 'string' || !Object.hasOwn(authority.keys || {}, a.keyId)) fail('unknown-issuer');
  if (!Number.isSafeInteger(a.issuedAt) || !Number.isSafeInteger(a.expiresAt) || a.issuedAt < 0 || a.expiresAt < 0 || a.issuedAt > now + 300000 || (a.expiresAt !== 0 && (a.expiresAt <= now || a.expiresAt <= a.issuedAt))) fail('authorization-time');
  if ((authority.revoked || []).some(item => item === inspected.contentHash || item === `${a.pluginId}@${a.version}` || item === `key:${a.keyId}`)) fail('revoked');
  if (typeof a.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(a.signature)) fail('signature-format');
  const { signature, ...payload } = a;
  let valid = false; try { valid = crypto.verify(null, Buffer.from(canonical(payload)), authority.keys[a.keyId], Buffer.from(signature, 'base64')); } catch { /* Fail closed. */ }
  if (!valid) fail('signature');
  return inspected;
}
function authorizePackage(input, privateKey, keyId, { issuedAt = Date.now(), expiresAt = 0 } = {}) {
  const { pkg, manifest, contentHash } = inspectPackage(input);
  const payload = { keyId, pluginId: manifest.id, version: manifest.version, contentHash, issuedAt, expiresAt };
  pkg.authorization = { ...payload, signature: crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') };
  return Buffer.from(JSON.stringify(pkg));
}
module.exports = { MAX_BYTES, CAPABILITIES, PluginViolation, canonical, digest, inspectPackage, verifyPackage, authorizePackage };
