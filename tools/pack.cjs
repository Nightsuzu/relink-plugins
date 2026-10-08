'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inspectPackage, MAX_BYTES, MAX_ASSET_BYTES, AUTHORIZATION_RESERVE } = require('../runtime/package.cjs');
const source = path.resolve(process.argv[2] || path.join(__dirname, '../examples/hello-relink'));
const output = path.resolve(process.argv[3] || 'hello-relink.unsigned.rlplugin');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const files = Object.create(null);
const entries = fs.readdirSync(source);
if (entries.length > 33) throw new Error('At most 32 assets are supported.');
let size = 0;
for (const file of entries) {
  if (file === 'manifest.json') continue;
  const stat = fs.lstatSync(path.join(source, file));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_BYTES) throw new Error('Only flat regular assets up to 75 MiB are supported.');
  size += stat.size; if (size > MAX_ASSET_BYTES) throw new Error('Total assets exceed 75 MiB.');
  files[file] = fs.readFileSync(path.join(source, file)).toString('base64');
}
const bytes = Buffer.from(JSON.stringify({ format: 1, manifest, files }));
if (bytes.length > MAX_BYTES - AUTHORIZATION_RESERVE) throw new Error('The final signed package must fit within 100 MiB; leave 1 KiB for authorization.');
const info = inspectPackage(bytes);
fs.writeFileSync(output, bytes);
console.log(JSON.stringify({ output, id: manifest.id, version: manifest.version, contentHash: info.contentHash, authorized: false }));
