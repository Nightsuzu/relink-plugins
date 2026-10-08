'use strict';
// Standalone development preview: mock state only, never connects to Relink.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { inspectPackage, MAX_ASSET_BYTES } = require('../runtime/package.cjs');
const source = path.resolve(process.argv[2] || path.join(__dirname, '../examples/hello-relink'));
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const files = {};
const entries = fs.readdirSync(source);
if (entries.length > 33) throw new Error('At most 32 assets are supported.');
let size = 0;
for (const file of entries) {
  if (file === 'manifest.json') continue;
  const full = path.join(source, file), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_BYTES) throw new Error('Only flat regular assets up to 75 MiB are supported.');
  size += stat.size; if (size > MAX_ASSET_BYTES) throw new Error('Total assets exceed 75 MiB.');
  files[file] = fs.readFileSync(full).toString('base64');
}
const { assets } = inspectPackage(JSON.stringify({ format: 1, manifest, files }));
const preview = `let state={authenticated:true,connected:true,inVoice:true,roomName:'插件开发预览',memberCount:3,muted:false,deafened:false,sharing:false};const listeners=new Set();window.relinkPlugin=Object.freeze({getState:async()=>({...state}),onState:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},action:async name=>{if(name==='mute')state.muted=!state.muted;if(name==='deafen')state.deafened=!state.deafened;if(name==='expand'||name==='collapse')document.body.classList.toggle('preview-expanded',name==='expand');for(const fn of listeners)fn({...state})}});`;
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? manifest.entry : req.url.slice(1);
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
  let body, type;
  if (file === '__preview.js') { body = preview; type = types.js; }
  else if (file === '__preview.css') { body = 'body{width:320px!important;margin:40px auto!important;background:#111319!important}body.preview-expanded{width:400px!important}'; type = types.css; }
  else if (assets.has(file)) {
    body = assets.get(file); type = types[file.split('.').pop()];
    if (file === manifest.entry) body = Buffer.from(body.toString().replace(/<head>/i, '<head><script src="/__preview.js"></script><link rel="stylesheet" href="/__preview.css">'));
  } else { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': type }); res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log(`Development preview (mock data, not an authorized client): http://127.0.0.1:${server.address().port}/`));
