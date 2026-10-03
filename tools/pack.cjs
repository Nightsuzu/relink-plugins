'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inspectPackage, MAX_BYTES } = require('../runtime/package.cjs');
const source = path.resolve(process.argv[2] || path.join(__dirname, '../examples/island'));
const output = path.resolve(process.argv[3] || 'island.unsigned.rlplugin');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const files = Object.create(null);
const entries = fs.readdirSync(source);
if (entries.length > 33) throw new Error('At most 32 assets are supported.');
let size = 0;
for (const file of entries) {
  if (file === 'manifest.json') continue;
  const stat = fs.lstatSync(path.join(source, file));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES / 2) throw new Error('Only flat regular assets up to 1 MiB are supported.');
  size += stat.size; if (size > MAX_BYTES / 2) throw new Error('Total assets exceed 1 MiB.');
  files[file] = fs.readFileSync(path.join(source, file)).toString('base64');
}
const bytes = Buffer.from(JSON.stringify({ format: 1, manifest, files }));
const info = inspectPackage(bytes);
fs.writeFileSync(output, bytes);
console.log(JSON.stringify({ output, id: manifest.id, version: manifest.version, contentHash: info.contentHash, authorized: false }));
