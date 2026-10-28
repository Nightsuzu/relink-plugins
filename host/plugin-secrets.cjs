'use strict';
// Plugin API v4 `secrets`: values the user types for a plugin (API keys). Stored encrypted with
// the operating system (Electron safeStorage); plugins only learn whether a value is set. The
// network host fills a secret into a request header for the plugin that declared it.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_VALUE = 4096;

class PluginSecrets {
  constructor(host, safeStorage) {
    this.host = host; this.safeStorage = safeStorage;
    this.file = path.join(host.root, 'secrets.json');
    this.data = {}; // pluginId -> { secretId: base64 ciphertext }
    this.cache = new Map(); // `${pluginId}\0${secretId}` -> plaintext, only for this run
  }
  async load() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 262144) throw new Error('too large');
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.data = raw;
    } catch (error) { if (error.code !== 'ENOENT') this.data = {}; }
  }
  async save() {
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 }); await fs.rename(tmp, this.file);
  }
  available() { return Boolean(this.safeStorage?.isEncryptionAvailable?.()); }
  declared(r) { return (r?.manifest.secrets || []); }
  /** For the settings page: which declared secrets have a value. Never the value. */
  status(r) {
    const saved = this.data[r.manifest.id] || {};
    return this.declared(r).map(s => ({ id: s.id, label: s.label, set: typeof saved[s.id] === 'string' }));
  }
  read(pluginId, secretId) {
    const key = pluginId + '\0' + secretId;
    if (this.cache.has(key)) return this.cache.get(key);
    const stored = this.data[pluginId]?.[secretId];
    if (typeof stored !== 'string' || !this.available()) return '';
    let value = '';
    try { value = this.safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { value = ''; }
    if (value) this.cache.set(key, value);
    return value;
  }
  async set(pluginId, secretId, value) {
    const r = this.host.records.get(pluginId);
    if (!r || !this.declared(r).some(s => s.id === secretId)) throw new Error('插件没有声明这个密钥。');
    const key = pluginId + '\0' + secretId;
    if (value === null || value === '') {
      if (this.data[pluginId]) delete this.data[pluginId][secretId];
      this.cache.delete(key);
    } else {
      if (typeof value !== 'string' || value.length > MAX_VALUE || /[\x00-\x1f\x7f]/.test(value)) throw new Error('密钥格式无效。');
      if (!this.available()) throw new Error('系统加密不可用，无法安全保存密钥。');
      this.data[pluginId] = { ...(this.data[pluginId] || {}), [secretId]: this.safeStorage.encryptString(value).toString('base64') };
      this.cache.set(key, value);
    }
    await this.save();
    return this.status(r);
  }
  async forget(pluginId) {
    for (const key of [...this.cache.keys()]) if (key.startsWith(pluginId + '\0')) this.cache.delete(key);
    if (!this.data[pluginId]) return;
    delete this.data[pluginId];
    await this.save();
  }
  register(plugin, main) {
    const h = this.host;
    h.ipcMain.handle('relink:plugins:secret-set', main((id, secretId, value) => h.serialize(async () => { const result = await this.set(id, secretId, value); h.notify(); return result; })));
    h.ipcMain.handle('relink:plugin:secrets', event => {
      const r = plugin(event, 'any');
      if (!r || h.disposed || h.incident || !r.manifest.capabilities.includes('secrets')) throw new Error('未获授权的插件接口');
      return Object.fromEntries(this.status(r).map(s => [s.id, s.set]));
    });
  }
}

module.exports = { PluginSecrets };
