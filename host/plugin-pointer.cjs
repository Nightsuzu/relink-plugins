'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// One event-driven helper per host. Coordinates stay in the trusted host;
// sandboxed plugins receive only a dismissal, never global mouse activity.
class PluginPointer {
  constructor(onDown, onCursor = () => {}, runtime = {}) {
    this.onDown = onDown; this.onCursor = onCursor;
    this.spawn = runtime.spawn || spawn; this.platform = runtime.platform || process.platform;
    this.findExecutable = runtime.findExecutable || (() => [path.join(process.resourcesPath || '', 'plugin-native/RelinkMediaBridge.exe'), path.join(__dirname, '../plugin-sdk/native/bin/RelinkMediaBridge.exe'), path.join(__dirname, '../native/bin/RelinkMediaBridge.exe')].find(p => fs.existsSync(p)));
    this.setTimer = runtime.setTimeout || setTimeout; this.clearTimer = runtime.clearTimeout || clearTimeout;
    this.running = false; this.failures = 0;
  }
  start() {
    this.running = true;
    if (this.child || this.retryTimer || this.platform !== 'win32') return;
    const executable = this.findExecutable();
    if (!executable) { this.retry(); return; }
    let child;
    try { child = this.spawn(executable, ['--pointer-watch', String(process.pid)], { windowsHide:true, stdio:['ignore','pipe','ignore'] }); }
    catch { this.retry(); return; }
    this.child = child; this.ready = false; this.startedAt = Date.now(); let buffer = '';
    const fail = () => {
      if (this.child !== child) return;
      this.child = null; this.ready = false; this.clearTimer(this.readyTimer); this.readyTimer = null;
      this.onCursor(false); child.kill();
      if (Date.now() - this.startedAt >= 30000) this.failures = 0;
      this.retry();
    };
    child.on('error', fail); child.on('exit', fail);
    this.readyTimer = this.setTimer(fail, 5000); this.readyTimer?.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk; if (buffer.length > 16384) return fail();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,end).trim(); buffer = buffer.slice(end+1);
        if (line === 'READY') { this.ready = true; this.clearTimer(this.readyTimer); this.readyTimer = null; continue; }
        if (/^CURSOR [01]$/.test(line)) { this.onCursor(line === 'CURSOR 1'); continue; }
        const match = /^DOWN (-?\d{1,8}) (-?\d{1,8})$/.exec(line);
        if (match) this.onDown({ x:Number(match[1]), y:Number(match[2]) });
      }
    });
  }
  retry() {
    if (!this.running || this.retryTimer || this.platform !== 'win32') return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; if (this.running) this.start(); }, delay);
    this.retryTimer?.unref?.();
  }
  stop() {
    this.running = false; this.failures = 0; this.clearTimer(this.retryTimer); this.clearTimer(this.readyTimer);
    this.retryTimer = null; this.readyTimer = null;
    const child = this.child; this.child = null; this.ready = false; this.onCursor(false); child?.kill();
  }
}
module.exports = { PluginPointer };
