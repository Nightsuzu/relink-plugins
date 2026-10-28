'use strict';
// Plugin developer mode: run one unsigned plugin from a local folder in the real
// client while writing it. It is switched on by hand for this run of Relink only,
// loads exactly one folder, and the plugin is marked 「开发中」 everywhere it appears.
// The plugin gets the same sandbox and permission checks as a signed one: no Node,
// no account identifiers, only the capabilities its manifest declares. Signed packages
// keep every existing rule, including the security exit for unsigned or altered .rlplugin files.
// Only this plugin gets DevTools and a console log; signed plugins never do.
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const { MAX_ASSET_BYTES, inspectPackage, digest, describeManifestError } = require('../runtime/package.cjs');

const ASSET = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(html|js|css|svg|png|webp)$/;
const LOG_LIMIT = 200, LOG_TEXT = 2000;
const LEVELS = ['debug', 'info', 'warning', 'error'];
const SURFACE_NAMES = { overlay: '浮层', panel: '面板', background: '后台页面' };

/** Reads `manifest.json` and the flat assets beside it into the package format, without a signature. */
async function readFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\x00-\x1f]/.test(folder)) throw new Error('请选择插件所在的文件夹。');
  const entries = await fs.readdir(folder, { withFileTypes: true });
  if (!entries.some(entry => entry.name === 'manifest.json' && entry.isFile())) throw new Error('文件夹里没有 manifest.json。');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')); }
  catch { throw new Error('manifest.json 不是有效的 JSON。'); }
  const files = {}; let size = 0, count = 0;
  for (const entry of entries) {
    if (entry.name === 'manifest.json' || entry.name.startsWith('.')) continue;
    // Same flat layout as a package: sub-folders, links and other file types are ignored.
    if (!entry.isFile() || !ASSET.test(entry.name)) continue;
    if (++count > 32) throw new Error('插件最多包含 32 个资源文件。');
    const bytes = await fs.readFile(path.join(folder, entry.name));
    size += bytes.length;
    if (size > MAX_ASSET_BYTES) throw new Error('插件资源总大小超出限制。');
    files[entry.name] = bytes.toString('base64');
  }
  try {
    const inspected = inspectPackage(JSON.stringify({ format: 1, manifest, files }));
    const { pkg, ...record } = inspected;
    return record;
  } catch (error) {
    // Report the manifest problem to the author; an unsigned folder is never a security incident.
    throw new Error(`插件清单未通过检查：${error.code ? describeManifestError(error.code, manifest) : error.message}`);
  }
}

class PluginDeveloper {
  constructor(host) { this.host = host; this.enabled = false; this.folder = ''; this.watcher = null; this.reloadTimer = null; this.error = ''; this.entries = []; this.pending = []; this.flushTimer = null; }
  record() { return [...this.host.records.values()].find(r => r.dev); }
  status() {
    const record = this.record();
    return { enabled: this.enabled, folder: this.folder, pluginId: record?.manifest.id || '', error: this.error, surfaces: record ? this.host.surfaces(record).map(s => s.kind) : [] };
  }
  /** Collects console output and load failures of a plugin page under development. Signed plugins are never watched. */
  attach(r, wc, kind) {
    if (!r?.dev) return;
    wc.on('console-message', (details, level, message, line, sourceId) => {
      // Electron passes a details object; older versions passed the values separately.
      const d = typeof details?.message === 'string' ? details : { level: LEVELS[level] || 'info', message, lineNumber: line, sourceId };
      if (this.record() !== r) return;
      this.log(kind, LEVELS.includes(d.level) ? d.level : 'info', String(d.message), d.sourceId ? `${String(d.sourceId).split('/').pop()}:${d.lineNumber || 0}` : '');
    });
    wc.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (mainFrame && this.record() === r) this.log(kind, 'error', `页面没有加载成功（${description || code}）：${String(url).split('/').pop()}`); });
    wc.on('preload-error', () => { if (this.record() === r) this.log(kind, 'error', 'Relink 插件接口没有加载成功，请重新加载插件。'); });
  }
  log(surface, level, text, source = '') {
    const entry = { at: Date.now(), surface, level, text: text.length > LOG_TEXT ? text.slice(0, LOG_TEXT) + '…' : text, source };
    this.entries.push(entry); if (this.entries.length > LOG_LIMIT) this.entries.splice(0, this.entries.length - LOG_LIMIT);
    this.pending.push(entry); if (this.pending.length > LOG_LIMIT) this.pending.splice(0, this.pending.length - LOG_LIMIT);
    // A plugin that logs in a loop must not flood the main window: deliver in batches.
    this.flushTimer ||= setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending; this.pending = [];
      const w = this.host.getWindow();
      if (batch.length && w && !w.isDestroyed()) w.webContents.send('relink:plugins:developer-log', batch);
    }, 250);
    this.flushTimer.unref?.();
  }
  clearLogs() { this.entries = []; this.pending = []; return []; }
  openDevTools(kind) {
    const r = this.record();
    if (!this.enabled || !r) throw new Error('没有开发中的插件。');
    const surface = this.host.surfaces(r).find(s => s.kind === kind);
    if (!surface) throw new Error(`插件的${SURFACE_NAMES[kind] || '页面'}现在没有运行，请先开启插件。`);
    surface.wc.openDevTools({ mode: 'detach', title: `[开发中] ${r.manifest.name} · ${SURFACE_NAMES[kind]}` });
    return this.status();
  }
  register(main) {
    const h = this.host;
    h.ipcMain.handle('relink:plugins:developer', main(() => this.status()));
    h.ipcMain.handle('relink:plugins:developer-set', main(enabled => h.serialize(() => this.setEnabled(enabled === true))));
    h.ipcMain.handle('relink:plugins:developer-load', main(async () => {
      if (!this.enabled) throw new Error('请先打开插件开发者模式。');
      const result = await h.dialog.showOpenDialog(h.getWindow(), { title: '选择开发中的插件文件夹', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return this.status();
      return h.serialize(() => this.load(result.filePaths[0]));
    }));
    h.ipcMain.handle('relink:plugins:developer-reload', main(() => h.serialize(() => this.load(this.folder))));
    h.ipcMain.handle('relink:plugins:developer-logs', main(() => this.entries));
    h.ipcMain.handle('relink:plugins:developer-logs-clear', main(() => this.clearLogs()));
    h.ipcMain.handle('relink:plugins:developer-devtools', main(kind => this.openDevTools(kind)));
  }
  async setEnabled(enabled) {
    const h = this.host;
    if (enabled === this.enabled) return this.status();
    if (enabled) {
      const options = { type: 'warning', title: '插件开发者模式', message: '打开插件开发者模式？',
        detail: '你可以从本机的一个文件夹加载自己正在开发的插件，它没有经过 Relink 审核和签名。\n\n它和正式插件在同样的隔离环境里运行，只能使用 manifest 里声明的权限，拿不到账号和私信。界面上会一直显示「开发中」标记。\n\n只在本次运行有效，重启 Relink 后自动关闭。不要加载别人发给你的文件夹。',
        buttons: ['打开开发者模式', '取消'], defaultId: 1, cancelId: 1, noLink: true };
      const main = h.getWindow();
      const answer = main && !main.isDestroyed() ? await h.dialog.showMessageBox(main, options) : await h.dialog.showMessageBox(options);
      if (answer.response !== 0 || h.disposed || h.incident) return this.status();
      this.enabled = true; this.error = '';
      this.folder = typeof h.preferences.$developer?.folder === 'string' ? h.preferences.$developer.folder : '';
    } else {
      this.enabled = false; this.unload(); this.clearLogs();
    }
    h.notify();
    return this.status();
  }
  async load(folder) {
    const h = this.host;
    if (!this.enabled || h.disposed || h.incident) throw new Error('请先打开插件开发者模式。');
    if (!folder) throw new Error('请选择插件文件夹。');
    let record;
    try { record = await readFolder(folder); }
    catch (error) { this.error = error.message; this.log('host', 'error', error.message); h.notify(); throw error; }
    const existing = h.records.get(record.manifest.id);
    if (existing && !existing.dev) { this.error = `已安装同名的正式插件（${record.manifest.id}），请换一个插件 ID。`; h.notify(); throw new Error(this.error); }
    const enabled = existing?.dev ? h.pref(record.manifest.id).enabled : true;
    this.unload({ keepWatcher: folder === this.folder });
    h.records.set(record.manifest.id, { ...record, dev: true, devFolder: folder, file: null, packageHash: digest(Buffer.from(record.contentHash)), builtin: false, window: null, error: null });
    h.preferences[record.manifest.id] = { ...h.pref(record.manifest.id), enabled };
    h.preferences.$developer = { folder };
    if (folder !== this.folder) this.clearLogs();
    this.folder = folder; this.error = '';
    this.log('host', 'info', `已加载 ${record.manifest.name} v${record.manifest.version}`);
    await h.save();
    this.watch(folder);
    await h.sync(h.records.get(record.manifest.id)).catch(error => h.handleError(h.records.get(record.manifest.id), error));
    h.notify();
    return this.status();
  }
  /** Saving a file in the folder reloads the plugin, like a dev server. */
  watch(folder) {
    if (this.watcher && this.watchedFolder === folder) return;
    this.watcher?.close(); this.watcher = null;
    try {
      this.watcher = watch(folder, { persistent: false }, () => {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => { void this.host.serialize(() => this.load(folder)).catch(() => {}); }, 300);
      });
      this.watchedFolder = folder;
    } catch { /* Manual reload still works. */ }
  }
  unload({ keepWatcher = false } = {}) {
    const h = this.host;
    for (const r of [...h.records.values()]) if (r.dev) { r.removed = true; void h.release(r); h.records.delete(r.manifest.id); delete h.preferences[r.manifest.id]; }
    if (!keepWatcher) { clearTimeout(this.reloadTimer); this.watcher?.close(); this.watcher = null; this.watchedFolder = ''; }
  }
  stop() { this.enabled = false; clearTimeout(this.reloadTimer); clearTimeout(this.flushTimer); this.watcher?.close(); this.watcher = null; }
}

module.exports = { PluginDeveloper, readFolder };
