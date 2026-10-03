'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// One event-driven helper per host. Coordinates stay in the trusted host;
// sandboxed plugins receive only a dismissal, never global mouse activity.
class PluginPointer {
  constructor(onDown) { this.onDown = onDown; }
  start() {
    if (this.child || process.platform !== 'win32' || Date.now() < (this.retryAt || 0)) return;
    const executable = [path.join(process.resourcesPath || '', 'plugin-native/RelinkMediaBridge.exe'), path.join(__dirname, '../plugin-sdk/native/bin/RelinkMediaBridge.exe'), path.join(__dirname, '../native/bin/RelinkMediaBridge.exe')].find(p => fs.existsSync(p));
    if (!executable) return;
    const child = spawn(executable, ['--pointer-watch', String(process.pid)], { windowsHide:true, stdio:['ignore','pipe','ignore'] });
    this.child = child; this.ready = false; let buffer = '';
    const fail = () => { if (this.child !== child) return; this.stop(); this.retryAt = Date.now() + 5000; };
    child.on('error', fail); child.on('exit', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk; if (buffer.length > 16384) return fail();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,end).trim(); buffer = buffer.slice(end+1);
        if (line === 'READY') { this.ready = true; continue; }
        const match = /^DOWN (-?\d{1,8}) (-?\d{1,8})$/.exec(line);
        if (match) this.onDown({ x:Number(match[1]), y:Number(match[2]) });
      }
    });
  }
  stop() { const child = this.child; this.child = null; this.ready = false; child?.kill(); }
}
module.exports = { PluginPointer };
