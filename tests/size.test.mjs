import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,truncate,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {MAX_BYTES,authorizePackage,inspectPackage,runtimePackage}=require('../runtime/package.cjs');
const {PluginHost}=require('../host/plugin-host.cjs');
const {bounded}=require('../host/plugin-updates.cjs');
await mkdir(resolve('.work'),{recursive:true});

test('the native installer accepts a signed 100 MiB package with large assets and rejects one extra byte',async()=>{
 const directory=await mkdtemp(join(resolve('.work'),'plugin-size-'));
 try{
  const key=generateKeyPairSync('ed25519');
  const authority={keys:{fixture:key.publicKey.export({type:'spki',format:'pem'})},revoked:[]};
  // Almost all of the file is a real base64 asset, not metadata padding.
  const bytes=authorizePackage(JSON.stringify({format:1,manifest:{id:'size-fixture',name:'Size fixture',version:'1.0.0',apiVersion:1,entry:'index.html',description:'',capabilities:[]},files:{'index.html':Buffer.from('<p>size fixture</p>').toString('base64'),'asset.png':'AAAA'.repeat(Math.floor((75*1024*1024-4096)/3))}}),key.privateKey,'fixture');
  assert(bytes.length>MAX_BYTES-8192&&bytes.length<MAX_BYTES);
  const file=join(directory,'size-fixture.rlplugin'),padding=Buffer.alloc(MAX_BYTES-bytes.length,32);
  await writeFile(file,Buffer.concat([bytes,padding]));
  const installed=await PluginHost.prototype.readPackage.call({authority},file);
  assert.equal(installed.manifest.id,'size-fixture');
  assert(installed.assets.get('asset.png').length>74*1024*1024);
  const record={...runtimePackage(installed),file};
  assert.equal(Object.hasOwn(record,'pkg'),false);
  await PluginHost.prototype.check.call({authority},record);
  await truncate(file,MAX_BYTES+1);
  await assert.rejects(PluginHost.prototype.readPackage.call({authority},file),e=>e.code==='PLUGIN_TOO_LARGE');
 }finally{assert.equal(dirname(resolve(directory)),resolve('.work'));await rm(directory,{recursive:true,force:true});}
});

test('plugin downloads accept the limit and reject oversized headers or a streaming overflow',async()=>{
 // Reuse the real bounded downloader with a small limit to verify both paths.
 assert.equal((await bounded(async()=>new Response('abcd'),'https://example.invalid/plugin',4)).length,4);
 await assert.rejects(bounded(async()=>new Response('abcde',{headers:{'Content-Length':'5'}}),'https://example.invalid/plugin',4));
 await assert.rejects(bounded(async()=>new Response('abcde'),'https://example.invalid/plugin',4));
 assert.throws(()=>inspectPackage(Buffer.alloc(MAX_BYTES+1)),e=>e.code==='package-size');
});
