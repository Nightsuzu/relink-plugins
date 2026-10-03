'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_BYTES, PluginViolation, verifyPackage, digest } = require('../runtime/package.cjs');
const { sanitizeState, allowedAsset, actionPolicy, limiter } = require('./plugin-policy.cjs');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'none'";
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
class PluginHost {
  constructor({ app, BrowserWindow, session, screen, ipcMain, dialog, trustedIpc, getWindow, quit }) {
    Object.assign(this, { app, BrowserWindow, session, screen, ipcMain, dialog, trustedIpc, getWindow, quit });
    this.root = path.join(app.getPath('userData'), 'authorized-plugins');
    this.authority = require('./plugin-authority.json');
    this.records = new Map(); this.preferences = {}; this.state = sanitizeState();
    this.disposed = false; this.incident = null; this.queue = Promise.resolve();
    this.displayChanged = () => { for (const r of this.records.values()) if (r.window) this.position(r); };
  }
  async readPackage(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new PluginViolation('package-file');
    const handle = await fs.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_BYTES) throw new PluginViolation('package-file');
      // Read at most one byte beyond the observed size: concurrent growth cannot allocate arbitrary memory.
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > opened.size) throw new PluginViolation('package-changed');
      return verifyPackage(buffer.subarray(0, length), this.authority);
    } finally { await handle.close(); }
  }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const preferencesFile = path.join(this.root, 'preferences.json');
      if ((await fs.stat(preferencesFile)).size > 65536) throw new Error('Plugin preferences are too large.');
      const raw = JSON.parse(await fs.readFile(preferencesFile, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.preferences = raw;
    } catch (error) { if (error.code !== 'ENOENT') this.preferences = {}; }
    const builtin = path.join(__dirname, 'relink-island.rlplugin');
    this.records.set('relink-island', { ...await this.readPackage(builtin), file: builtin, builtin: true, window: null, error: null });
    for (const file of await fs.readdir(this.root)) {
      if (!file.endsWith('.rlplugin')) continue;
      if (this.records.size >= 16) break;
      const full = path.join(this.root, file);
      let item;
      try { item = await this.readPackage(full); }
      catch (e) { if (e instanceof PluginViolation) e.managedFile = full; throw e; }
      if (file !== `${item.manifest.id}.rlplugin` || this.records.has(item.manifest.id)) { const error = new PluginViolation('duplicate-identity'); error.managedFile = full; throw error; }
      this.records.set(item.manifest.id, { ...item, file: full, builtin: false, window: null, error: null });
    }
    this.register();
    this.screen.on('display-removed', this.displayChanged);
    this.screen.on('display-metrics-changed', this.displayChanged);
    this.auditTimer = setInterval(() => void this.audit(), 10000); this.auditTimer.unref();
  }
  pref(id) {
    const value = this.preferences[id] || {};
    return { enabled: value.enabled === true, displayMode: value.displayMode === 'voice' ? 'voice' : 'always', displayId: typeof value.displayId === 'string' ? value.displayId : 'primary' };
  }
  list() {
    return {
      plugins: [...this.records.values()].map(r => ({ id: r.manifest.id, name: r.manifest.name, description: r.manifest.description, version: r.manifest.version, capabilities: r.manifest.capabilities, builtin: r.builtin, ...this.pref(r.manifest.id), status: r.error ? 'failed' : r.window ? 'active' : this.pref(r.manifest.id).enabled ? 'ready' : 'disabled', error: r.error })),
      displays: this.screen.getAllDisplays().map((d, index) => ({ id: String(d.id), name: d.label || `显示器 ${index + 1}` })),
    };
  }
  notify() { const w = this.getWindow(); if (w && !w.isDestroyed()) w.webContents.send('relink:plugins:changed', this.list()); }
  serialize(operation) { const pending = this.queue.then(operation); this.queue = pending.catch(() => {}); return pending; }
  async save() {
    const target = path.join(this.root, 'preferences.json'), tmp = target + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.preferences)); await fs.rename(tmp, target);
  }
  register() {
    const main = (fn) => async (event, ...args) => {
      if (!this.trustedIpc(event)) throw new Error('来源不允许。');
      if (this.incident || this.disposed) throw new Error('插件模块已停止。');
      try { return await fn(...args); } catch (e) { if (e instanceof PluginViolation) void this.violation(e); throw e; }
    };
    this.ipcMain.handle('relink:plugins:list', main(() => this.list()));
    this.ipcMain.handle('relink:plugins:configure', main((id, patch) => this.serialize(async () => {
      const r = this.records.get(id);
      if (!r || !patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['enabled', 'displayMode', 'displayId'].includes(k))) throw new Error('插件设置无效。');
      const p = { ...this.pref(id) };
      if (Object.hasOwn(patch, 'enabled')) { if (typeof patch.enabled !== 'boolean') throw new Error('插件设置无效。'); p.enabled = patch.enabled; }
      if (Object.hasOwn(patch, 'displayMode')) { if (!['always', 'voice'].includes(patch.displayMode)) throw new Error('显示方式无效。'); p.displayMode = patch.displayMode; }
      if (Object.hasOwn(patch, 'displayId')) { if (patch.displayId !== 'primary' && !this.screen.getAllDisplays().some(d => String(d.id) === patch.displayId)) throw new Error('显示器不可用。'); p.displayId = patch.displayId; }
      if (p.enabled) { await this.check(r); if (r.manifest.apiVersion !== 1) throw new Error('此插件需要更新版本的 Relink。'); }
      if (p.enabled && !this.pref(id).enabled && [...this.records.keys()].filter(other => other !== id && this.pref(other).enabled).length >= 3) throw new Error('最多同时启用 3 个插件，请先关闭一个。');
      this.preferences[id] = p; r.error = null;
      await this.save(); await this.sync(r); if (r.window) this.position(r); this.notify(); return this.list();
    })));
    this.ipcMain.handle('relink:plugins:install', main(() => this.serialize(async () => {
      const result = await this.dialog.showOpenDialog(this.getWindow(), { title: '安装 Relink 授权插件', properties: ['openFile'], filters: [{ name: 'Relink 插件', extensions: ['rlplugin'] }] });
      if (result.canceled || !result.filePaths[0]) return this.list();
      const item = await this.readPackage(result.filePaths[0]);
      const existing = this.records.get(item.manifest.id);
      if (existing?.builtin) throw new Error('内置插件随 Relink 更新。');
      if (!existing && this.records.size >= 16) throw new Error('最多安装 16 个插件。');
      const file = path.join(this.root, `${item.manifest.id}.rlplugin`);
      // Re-serialize approved bytes so file changes between verification and copying cannot enter the store.
      const bytes = Buffer.from(JSON.stringify(item.pkg));
      const tmp = file + '.tmp'; await fs.writeFile(tmp, bytes); await fs.rename(tmp, file);
      this.release(existing);
      this.preferences[item.manifest.id] = { ...this.pref(item.manifest.id), enabled: false };
      this.records.set(item.manifest.id, { ...item, packageHash: digest(bytes), file, builtin: false, window: null, error: null });
      await this.save(); this.notify(); return this.list();
    })));
    this.ipcMain.on('relink:plugins:publish', (event, value) => {
      if (!this.trustedIpc(event) || this.incident || this.disposed) return;
      const state = sanitizeState(value); if (JSON.stringify(state) === JSON.stringify(this.state)) return;
      this.state = state;
      for (const r of this.records.values()) {
        if (r.window && r.manifest.capabilities.includes('voice.read')) r.window.webContents.send('relink:plugin:state', state);
        void this.sync(r).catch(e => this.handleError(r, e));
      }
    });
    const plugin = (event) => [...this.records.values()].find(r => r.window && !r.window.isDestroyed() && event.sender === r.window.webContents && event.senderFrame === r.window.webContents.mainFrame && event.senderFrame.url === `relink-plugin://${r.manifest.id}/${r.manifest.entry}`);
    this.ipcMain.handle('relink:plugin:state', (event) => {
      const r = plugin(event); if (!r || this.incident || !r.manifest.capabilities.includes('voice.read')) throw new Error('来源不允许。');
      return this.state;
    });
    this.ipcMain.handle('relink:plugin:action', async (event, value) => {
      const r = plugin(event); if (!r || this.incident) throw new Error('来源不允许。');
      if (!r.limit()) throw new Error('操作过于频繁。');
      try {
        if (!actionPolicy(value, r.manifest.capabilities, this.state)) return;
        if (value === 'expand' || value === 'collapse') { r.expanded = value === 'expand'; this.position(r); }
        else {
          const w = this.getWindow(); if (!w || w.isDestroyed()) return;
          if (value === 'show') { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
          w.webContents.send('relink:plugins:action', value);
        }
      } catch (e) { if (e instanceof PluginViolation) void this.violation(e, r.manifest.id); throw e; }
    });
    this.ipcMain.on('relink:plugins:shutdown-ready', (event, id) => { if (this.trustedIpc(event) && id === this.incident?.id) this.finishQuit?.(); });
  }
  position(r) {
    if (!r.window || r.window.isDestroyed()) return;
    const pref = this.pref(r.manifest.id);
    const display = this.screen.getAllDisplays().find(d => String(d.id) === pref.displayId) || this.screen.getPrimaryDisplay();
    const a = display.workArea, width = Math.min(r.expanded ? 400 : 320, a.width), height = Math.min(r.expanded ? 200 : 74, a.height);
    r.window.setBounds({ x: Math.round(a.x + (a.width - width) / 2), y: a.y + Math.min(10, Math.max(0, a.height - height)), width, height }, false);
  }
  async check(r) {
    let current; try { current = await this.readPackage(r.file); } catch (e) { const error = e instanceof PluginViolation ? e : new PluginViolation('package-missing'); error.managedFile = r.file; throw error; }
    if (current.packageHash !== r.packageHash) { const error = new PluginViolation('package-changed'); error.managedFile = r.file; throw error; }
  }
  async sync(r) {
    const show = !this.disposed && !this.incident && this.pref(r.manifest.id).enabled && this.state.authenticated && (this.pref(r.manifest.id).displayMode !== 'voice' || this.state.inVoice);
    if (!show || r.error) { this.close(r); return; }
    if (r.window || r.opening) return;
    if ([...this.records.values()].filter(item => item.window || item.opening).length >= 3) { r.error = '最多同时运行 3 个插件。'; this.notify(); return; }
    r.opening = true;
    let createdWindow = null;
    try {
      await this.check(r);
      if (r.manifest.apiVersion !== 1) { r.error = '此插件需要更新版本的 Relink。'; this.notify(); return; }
      // Dedicated in-memory partition. No account session, storage or default preload is shared.
      const ses = r.session || this.session.fromPartition(`relink-plugin-${r.manifest.id}`, { cache: false });
      if (!r.session) {
        await ses.protocol.handle('relink-plugin', request => {
        const name = allowedAsset(request.url, r.manifest.id, r.assets);
        if (!name || request.method !== 'GET') return new Response('', { status: 403 });
        return new Response(r.assets.get(name), { headers: { 'Content-Type': MIME[name.split('.').pop()], 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
        });
        ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
        ses.setDevicePermissionHandler(() => false);
        ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedAsset(details.url, r.manifest.id, r.assets) }));
        ses.on('will-download', event => event.preventDefault());
        r.session = ses;
      }
      const w = new this.BrowserWindow({ width: 320, height: 74, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, title: r.manifest.name, webPreferences: { preload: path.join(__dirname, 'plugin-preload.cjs'), session: ses, nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, spellcheck: false, devTools: false, backgroundThrottling: true } });
      r.window = w; r.expanded = false; r.limit = limiter(); r.overBudget = 0;
      createdWindow = w;
      const wc = w.webContents;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', event => event.preventDefault());
      wc.on('will-frame-navigate', event => event.preventDefault());
      wc.on('will-attach-webview', event => event.preventDefault());
      wc.on('render-process-gone', () => { if (r.window === w && !this.disposed && !this.incident) this.handleError(r, new Error('插件已暂停，主通话保持运行。')); });
      wc.on('unresponsive', () => this.handleError(r, new Error('插件响应超时，已暂停。')));
      w.once('closed', () => { if (r.window === w) r.window = null; });
      this.position(r);
      await w.loadURL(`relink-plugin://${r.manifest.id}/${r.manifest.entry}`);
      if (this.disposed || this.incident || !this.state.authenticated || !this.pref(r.manifest.id).enabled || (this.pref(r.manifest.id).displayMode === 'voice' && !this.state.inVoice)) { this.close(r); return; }
      w.showInactive(); this.notify();
    } catch (error) {
      if (error instanceof PluginViolation) throw error;
      if (!this.disposed && !this.incident && this.state.authenticated && this.pref(r.manifest.id).enabled && (!createdWindow || r.window === createdWindow)) this.handleError(r, error);
    } finally { r.opening = false; }
  }
  close(r) { if (!r?.window) return; const w = r.window; r.window = null; if (!w.isDestroyed()) w.destroy(); }
  release(r) {
    if (!r) return;
    this.close(r);
    if (r.session) { r.session.protocol.unhandle('relink-plugin'); void r.session.clearStorageData().catch(() => {}); r.session = null; }
  }
  handleError(r, error) {
    if (error instanceof PluginViolation) { void this.violation(error, r.manifest.id); return; }
    r.error = '插件已暂停，请关闭后重新启用。'; this.close(r); this.notify();
  }
  async audit() {
    if (this.disposed || this.incident || this.auditing) return; this.auditing = true;
    try {
      await this.queue;
      for (const r of this.records.values()) {
        await this.check(r);
        if (r.window) {
          const metric = this.app.getAppMetrics().find(m => m.pid === r.window.webContents.getOSProcessId());
          r.overBudget = metric?.memory?.workingSetSize > 196608 ? (r.overBudget || 0) + 1 : 0;
          if (r.overBudget >= 2) this.handleError(r, new Error('插件超过内存预算。'));
        }
      }
    } catch (e) { if (e instanceof PluginViolation) void this.violation(e); }
    finally { this.auditing = false; }
  }
  async violation(error, pluginId = 'unknown') {
    if (this.incident || this.disposed) return;
    this.incident = { id: randomUUID(), at: new Date().toISOString(), code: error.code || 'unauthorized', pluginId };
    for (const r of this.records.values()) this.release(r);
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(path.join(this.root, 'last-security-incident.json'), JSON.stringify(this.incident));
      const file = error.managedFile || this.records.get(pluginId)?.file;
      // Only an immediate child of the managed store can be quarantined. Built-in app files and external import sources are never moved.
      if (file && path.dirname(path.resolve(file)) === path.resolve(this.root) && path.extname(file) === '.rlplugin') await fs.rename(file, file + `.blocked-${this.incident.id}`);
    } catch { /* Shutdown must not depend on disk availability. */ }
    // Give the trusted application a bounded chance to leave voice and finish local draft writes.
    let done = false;
    this.finishQuit = () => { if (done) return; done = true; clearTimeout(this.quitTimer); this.quit(); };
    this.quitTimer = setTimeout(this.finishQuit, 1200);
    const w = this.getWindow(); if (w && !w.isDestroyed()) w.webContents.send('relink:plugins:shutdown', this.incident);
  }
  dispose() {
    this.disposed = true; clearInterval(this.auditTimer);
    this.screen.removeListener('display-removed', this.displayChanged); this.screen.removeListener('display-metrics-changed', this.displayChanged);
    for (const r of this.records.values()) this.release(r);
  }
}
module.exports = { PluginHost, CSP };
