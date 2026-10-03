'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inspectPackage } = require('../runtime/package.cjs');
const source = path.resolve(process.argv[2] || path.join(__dirname, '../examples/island'));
const output = path.resolve(process.argv[3] || 'island.unsigned.rlplugin');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const files = Object.create(null);
for (const file of fs.readdirSync(source)) {
  if (file === 'manifest.json') continue;
  const stat = fs.lstatSync(path.join(source, file));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only flat regular assets are supported.');
  files[file] = fs.readFileSync(path.join(source, file)).toString('base64');
}
const bytes = Buffer.from(JSON.stringify({ format: 1, manifest, files }));
const info = inspectPackage(bytes);
fs.writeFileSync(output, bytes);
console.log(JSON.stringify({ output, id: manifest.id, version: manifest.version, contentHash: info.contentHash, authorized: false }));
