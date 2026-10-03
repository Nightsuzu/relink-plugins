'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_BYTES, PluginViolation, verifyPackage, digest, pluginSettings } = require('../runtime/package.cjs');
const { sanitizeState, allowedAsset, actionPolicy, limiter } = require('./plugin-policy.cjs');
const { candidates } = require('./game-catalog.cjs');
const { PluginServices } = require('./plugin-services.cjs');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'none'";
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
class PluginHost {
  constructor({ app, BrowserWindow, session, screen, ipcMain, dialog, trustedIpc, getWindow, quit, listGameWindows, mediaService }) {
    Object.assign(this, { app, BrowserWindow, session, screen, ipcMain, dialog, trustedIpc, getWindow, quit, listGameWindows, mediaService });
    this.root = path.join(app.getPath('userData'), 'authorized-plugins');
    this.authority = require('./plugin-authority.json');
    this.records = new Map(); this.preferences = {}; this.state = sanitizeState();
    this.services = new PluginServices(this, mediaService);
    this.disposed = false; this.incident = null; this.queue = Promise.resolve(); this.gameMode = false;
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
    // Plugins are opt-in downloads. A fresh client has no bundled plugin.
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
    // Only poll while an overlay is visible. This reuses the native window list,
    // never a capture or FPS session, and never exposes process names to plugins.
    if (this.listGameWindows) {
      this.gameTimer = setInterval(() => void this.pollGames(), 1500); this.gameTimer.unref();
    }
  }
  pref(id) {
    const value = this.preferences[id] || {};
    return { enabled: value.enabled === true, displayMode: value.displayMode === 'voice' ? 'voice' : 'always', displayId: typeof value.displayId === 'string' ? value.displayId : 'primary',settings:pluginSettings(this.records.get(id)?.manifest||{},value.settings) };
  }
  list() {
    return {
      plugins: [...this.records.values()].map(r => ({ id: r.manifest.id, name: r.manifest.name, description: r.manifest.description, version: r.manifest.version, capabilities: r.manifest.capabilities, author:r.manifest.author?{name:r.manifest.author.name,avatar:r.manifest.author.avatar?`data:image/${r.manifest.author.avatar.endsWith('.webp')?'webp':'png'};base64,${r.assets.get(r.manifest.author.avatar).toString('base64')}`:''}:null,settingsSchema:r.manifest.settings||[], builtin: r.builtin, ...this.pref(r.manifest.id), status: r.error ? 'failed' : r.window ? 'active' : this.pref(r.manifest.id).enabled ? 'ready' : 'disabled', error: r.error })),
      displays: this.screen.getAllDisplays().map((d, index) => ({ id: String(d.id), name: d.label || `显示器 ${index + 1}` })),
    };
  }
  notify() { const w = this.getWindow(); if (w && !w.isDestroyed()) w.webContents.send('relink:plugins:changed', this.list()); }
  serialize(operation) { const pending = this.queue.then(operation); this.queue = pending.catch(() => {}); return pending; }
  async save() {
    const target = path.join(this.root, 'preferences.json'), tmp = target + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.preferences)); await fs.rename(tmp, target);
  }
  async installFile(source) {
    return this.serialize(async () => {
      if (this.disposed || this.incident) throw new Error('插件模块已停止。');
      if (typeof source !== 'string' || source.length > 32767 || !path.isAbsolute(source) || /[\x00-\x1f]/.test(source) || path.extname(source).toLowerCase() !== '.rlplugin') throw new Error('请选择下载好的 .rlplugin 文件。');
      let item;
      try { item = await this.readPackage(source); }
      catch (e) { if (e instanceof PluginViolation) void this.violation(e); throw e; }
      const existing = this.records.get(item.manifest.id);
      if (existing?.builtin) throw new Error('内置插件随 Relink 更新。');
      if (!existing && this.records.size >= 16) throw new Error('最多安装 16 个插件。');
      const labels = { 'voice.read':'读取通话状态','voice.mute':'控制麦克风静音','voice.deafen':'控制耳机拒听','app.show':'返回主窗口','window.resize':'调整插件浮窗','music.read':'读取支持的播放器曲目和封面','music.control':'控制播放器','music.lyrics':'匹配 LRCLIB 同步歌词','channels.read':'读取当前 Room 语音频道','channels.switch':'切换语音频道' };
      const options = { type:'question',title:existing ? '更新 Relink 插件' : '安装 Relink 插件',message:`${item.manifest.name} · v${item.manifest.version}`,detail:`${item.manifest.description}\n\n允许的功能：${item.manifest.capabilities.map(c => labels[c]).join('、') || '无'}\n\n已验证 Relink 发布签名。安装后默认关闭，可在设置 → 插件中开启。`,buttons:[existing ? '更新插件' : '安装插件','取消'],defaultId:0,cancelId:1,noLink:true };
      const main = this.getWindow();
      const confirm = main && !main.isDestroyed() ? await this.dialog.showMessageBox(main, options) : await this.dialog.showMessageBox(options);
      if (confirm.response !== 0 || this.disposed || this.incident) return this.list();
      const file = path.join(this.root, `${item.manifest.id}.rlplugin`);
      // Only the already verified bytes enter the store; no source re-read.
      const bytes = Buffer.from(JSON.stringify(item.pkg));
      const tmp = file + '.tmp'; await fs.writeFile(tmp, bytes); await fs.rename(tmp, file);
      this.release(existing);
      this.preferences[item.manifest.id] = { ...this.pref(item.manifest.id),enabled:false };
      this.records.set(item.manifest.id,{ ...item,packageHash:digest(bytes),file,builtin:false,window:null,error:null });
      await this.save(); this.notify();
      if (main && !main.isDestroyed()) main.webContents.send('relink:plugins:installed',{ id:item.manifest.id });
      return this.list();
    });
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
      if (!r || !patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['enabled', 'displayMode', 'displayId','settings'].includes(k))) throw new Error('插件设置无效。');
      const p = { ...this.pref(id) };
      if(Object.hasOwn(patch,'settings'))p.settings=pluginSettings(r.manifest,p.settings,patch.settings);
      if (Object.hasOwn(patch, 'enabled')) { if (typeof patch.enabled !== 'boolean') throw new Error('插件设置无效。'); p.enabled = patch.enabled; }
      if (Object.hasOwn(patch, 'displayMode')) { if (!['always', 'voice'].includes(patch.displayMode)) throw new Error('显示方式无效。'); p.displayMode = patch.displayMode; }
      if (Object.hasOwn(patch, 'displayId')) { if (patch.displayId !== 'primary' && !this.screen.getAllDisplays().some(d => String(d.id) === patch.displayId)) throw new Error('显示器不可用。'); p.displayId = patch.displayId; }
      if (p.enabled) { await this.check(r); if (r.manifest.apiVersion !== 1) throw new Error('此插件需要更新版本的 Relink。'); }
      if (p.enabled && !this.pref(id).enabled && [...this.records.keys()].filter(other => other !== id && this.pref(other).enabled).length >= 3) throw new Error('最多同时启用 3 个插件，请先关闭一个。');
      this.preferences[id] = p; r.error = null;
      await this.save(); await this.sync(r); if (r.window) {this.position(r);r.window.webContents.send('relink:plugin:settings',p.settings);} this.notify(); return this.list();
    })));
    this.ipcMain.handle('relink:plugins:install-file', main(file => this.installFile(file)));
    this.ipcMain.handle('relink:plugins:install', main(async () => {
      const result = await this.dialog.showOpenDialog(this.getWindow(), { title: '安装 Relink 授权插件', properties: ['openFile'], filters: [{ name: 'Relink 插件', extensions: ['rlplugin'] }] });
      if (result.canceled || !result.filePaths[0]) return this.list();
      return this.installFile(result.filePaths[0]);
    }));
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
    this.services.register(plugin);
    this.ipcMain.handle('relink:plugin:settings',event=>{const r=plugin(event);if(!r||this.incident)throw Error('来源不允许。');return this.pref(r.manifest.id).settings;});
    this.ipcMain.handle('relink:plugin:settings-update',(event,patch)=>{const r=plugin(event);if(!r||this.incident||this.disposed)throw Error('来源不允许。');if(!r.settingsLimit())throw Error('操作过于频繁。');return this.serialize(async()=>{if(plugin(event)!==r||this.incident||this.disposed)throw Error('来源不允许。');const p=this.pref(r.manifest.id);p.settings=pluginSettings(r.manifest,p.settings,patch);this.preferences[r.manifest.id]=p;await this.save();r.window?.webContents.send('relink:plugin:settings',p.settings);this.notify();return p.settings;});});
    this.ipcMain.handle('relink:plugin:state', (event) => {
      const r = plugin(event); if (!r || this.incident || !r.manifest.capabilities.includes('voice.read')) throw new Error('来源不允许。');
      return this.state;
    });
    this.ipcMain.handle('relink:plugin:presentation', (event) => {
      const r = plugin(event); if (!r || this.incident || !r.manifest.capabilities.includes('window.resize')) throw new Error('来源不允许。');
      if (!r.gameAware) {
        r.gameAware = true;
        if (this.gameMode) { r.expanded = true; this.position(r); void this.resize(r, false); }
      }
      this.position(r);
      return this.presentation(r);
    });
    this.ipcMain.handle('relink:plugin:action', async (event, value) => {
      const r = plugin(event); if (!r || this.incident) throw new Error('来源不允许。');
      // Geometry reversals coalesce into one pending native contraction; don't
      // let a quick double-click consume the voice-control action budget.
      if (!(value === 'expand' || value === 'collapse' ? r.resizeLimit() : r.limit())) throw new Error('操作过于频繁。');
      try {
        if (!actionPolicy(value, r.manifest.capabilities, this.state)) return;
        if (value === 'expand' || value === 'collapse') await this.resize(r, value === 'expand');
        else {
          const w = this.getWindow(); if (!w || w.isDestroyed()) return;
          if (value === 'show') { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
          w.webContents.send('relink:plugins:action', value);
        }
      } catch (e) { if (e instanceof PluginViolation) void this.violation(e, r.manifest.id); throw e; }
    });
    this.ipcMain.on('relink:plugins:shutdown-ready', (event, id) => { if (this.trustedIpc(event) && id === this.incident?.id) this.finishQuit?.(); });
  }
  presentation(r) {
    const display = this.screen.getAllDisplays().find(d => String(d.id) === this.pref(r.manifest.id).displayId) || this.screen.getPrimaryDisplay();
    return { gameMode: this.gameMode, topInset: Math.max(18, Math.min(128, display.workArea.y - display.bounds.y + 18)) };
  }
  async pollGames() {
    if (this.disposed || this.incident || this.pollingGames || ![...this.records.values()].some(r => r.window)) return;
    this.pollingGames = true;
    try {
      const rows = candidates(await this.listGameWindows());
      if (this.disposed || this.incident) return;
      // A launched known game keeps the notch compact even during Alt+Tab.
      const active = rows.some(r => r.known);
      this.gameMisses = active ? 0 : (this.gameMisses || 0) + 1;
      if (active || this.gameMisses >= 2) this.setGameMode(active);
      for (const r of this.records.values()) if (r.window && !r.window.isDestroyed()) r.window.setAlwaysOnTop(true, 'screen-saver');
    } catch { /* A failed native probe is not evidence that the game closed. */ }
    finally { this.pollingGames = false; }
  }
  setGameMode(value) {
    if (this.gameMode === value) return;
    this.gameMode = value;
    for (const r of this.records.values()) {
      if (!r.window || r.window.isDestroyed() || !r.gameAware) continue;
      // Keep a generous canvas for the morph; shrink it after the renderer settles.
      this.cancelResize(r);
      r.expanded = true; this.position(r);
      if (r.manifest.capabilities.includes('window.resize')) r.window.webContents.send('relink:plugin:presentation', this.presentation(r));
      r.resizeTimer = setTimeout(() => { r.resizeTimer = null; r.expanded = false; this.position(r); }, 600);
    }
  }
  cancelResize(r) {
    clearTimeout(r.resizeTimer); r.resizeTimer = null;
    r.resizeResolve?.(); r.resizeResolve = null;
  }
  resize(r, expanded) {
    this.cancelResize(r);
    // Older API-v1 plugins expect immediate resize and do not opt into the
    // presentation/morph contract. Keep their behaviour unchanged.
    if (!r.gameAware) { r.expanded = expanded; this.position(r); return Promise.resolve(); }
    if (expanded) { r.expanded = true; this.position(r); return Promise.resolve(); }
    // The renderer animates first, then the native canvas contracts. Rapid
    // reversal cancels this timer instead of cropping the outgoing content.
    return new Promise(resolve => {
      r.resizeResolve = resolve;
      r.resizeTimer = setTimeout(() => {
        r.resizeTimer = null; r.resizeResolve = null;
        r.expanded = false; this.position(r); resolve();
      }, 600);
    });
  }
  position(r) {
    if (!r.window || r.window.isDestroyed()) return;
    const pref = this.pref(r.manifest.id);
    const display = this.screen.getAllDisplays().find(d => String(d.id) === pref.displayId) || this.screen.getPrimaryDisplay();
    const gameMode = this.gameMode && r.gameAware;
    const a = r.gameAware ? display.bounds : display.workArea;
    const topInset = this.presentation(r).topInset;
    // Windows clamps even a frameless native window to 38 DIP. The visible
    // notch stays 28 DIP and its input shape excludes the transparent remainder.
    const width = Math.min(r.expanded ? 400 : gameMode ? 204 : 320, a.width), height = Math.min(r.expanded ? (r.gameAware ? (r.manifest.capabilities.includes('music.read') ? 382 : 242) + topInset : 200) : gameMode ? 38 : r.gameAware ? topInset + 70 : 74, a.height);
    // Presentation-aware windows share one screen-edge anchor. The renderer
    // spring moves the pill to/from the notch, avoiding a native 10px jump.
    const bounds = { x: Math.round(a.x + (a.width - width) / 2), y: a.y + (r.gameAware ? 0 : Math.min(10, Math.max(0, a.height - height))), width, height };
    const previous = r.window.getBounds();
    if (Object.keys(bounds).some(key => previous[key] !== bounds[key])) r.window.setBounds(bounds, false);
    if (process.platform === 'win32' && r.gameAware) {
      // A game notch must accept pointer input without taking keyboard focus
      // away from the game. Normal desktop mode retains keyboard navigation.
      if (r.focusable !== !gameMode) { r.window.setFocusable(!gameMode); r.focusable = !gameMode; }
      const shape = r.expanded ? { x:0,y:0,width,height } : { x:8,y:gameMode ? 0 : topInset,width:Math.max(1,width-16),height:gameMode ? 28 : 58 };
      r.window.setShape([shape]);
    }
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
      const w = new this.BrowserWindow({ width: 320, height: 74, minWidth: 0, minHeight: 0, thickFrame: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false, title: r.manifest.name, webPreferences: { preload: path.join(__dirname, 'plugin-preload.cjs'), session: ses, nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, spellcheck: false, devTools: false, backgroundThrottling: true } });
      r.window = w; r.expanded = false; r.gameAware = false; r.focusable = true; r.limit = limiter(); r.resizeLimit = limiter(24); r.settingsLimit = limiter(30); r.overBudget = 0;
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  close(r) { if (!r) return; this.cancelResize(r); if (!r.window) return; const w = r.window; r.window = null; if (!w.isDestroyed()) w.destroy(); }
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
    this.services.stop(); this.disposed = true; clearInterval(this.auditTimer); clearInterval(this.gameTimer);
    this.screen.removeListener('display-removed', this.displayChanged); this.screen.removeListener('display-metrics-changed', this.displayChanged);
    for (const r of this.records.values()) this.release(r);
  }
}
module.exports = { PluginHost, CSP };
