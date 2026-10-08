import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,unlink,symlink,rename,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{PluginHost}=require('../host/plugin-host.cjs');
const {authorizePackage,verifyPackage,runtimePackage,PluginViolation}=require('../runtime/package.cjs');
async function fixture(t,{expiresAt=0}={}){
 await mkdir(resolve('.work'),{recursive:true});
 const root=await mkdtemp(join(resolve('.work'),'plugin-audit-'));
 t.after(async()=>{assert.equal(dirname(root),resolve('.work'));await rm(root,{recursive:true,force:true});});
 const keys=generateKeyPairSync('ed25519'),authority={keys:{fixture:keys.publicKey.export({type:'spki',format:'pem'})},revoked:[]};
 const input={format:1,manifest:{id:'audit-plugin',name:'Audit fixture',version:'1.0.0',apiVersion:1,entry:'index.html',description:'',capabilities:[]},files:{'index.html':Buffer.from('<p>fixture</p>').toString('base64')}};
 const bytes=authorizePackage(JSON.stringify(input),keys.privateKey,'fixture',{issuedAt:Date.now()-1000,expiresAt}),file=join(root,'audit-plugin.rlplugin');
 await writeFile(file,bytes);const r={...runtimePackage(verifyPackage(bytes,authority)),file};
 const host={authority,readPackage(){throw Error('Audits must not parse or decode the package again');}};
 return {root,file,bytes,r,host,check:()=>PluginHost.prototype.check.call(host,r)};
}
test('installed audit retains decoded resources only and detects same-size edits and replacement',async t=>{
 const f=await fixture(t);assert.equal(Object.hasOwn(f.r,'pkg'),false);assert.equal(f.r.assets.get('index.html').toString(),'<p>fixture</p>');await f.check();
 const altered=Buffer.from(f.bytes);altered[altered.indexOf('Audit fixture')]='B'.charCodeAt(0);await writeFile(f.file,altered);
 await assert.rejects(f.check(),e=>e instanceof PluginViolation&&e.code==='package-changed'&&e.managedFile===f.file);
 await writeFile(f.file,f.bytes);await f.check();
 await writeFile(f.file+'.new',altered);await rename(f.file+'.new',f.file);
 await assert.rejects(f.check(),e=>e.code==='package-changed');
});
test('audits still enforce current revocations, expiry and issuer signatures',async t=>{
 const f=await fixture(t,{expiresAt:Date.now()+60000});await f.check();
 for(const revoked of [f.r.contentHash,'audit-plugin@1.0.0','key:fixture']){f.host.authority.revoked=[revoked];await assert.rejects(f.check(),e=>e.code==='revoked');}
 f.host.authority.revoked=[];
 const key=f.host.authority.keys.fixture;delete f.host.authority.keys.fixture;await assert.rejects(f.check(),e=>e.code==='unknown-issuer');f.host.authority.keys.fixture=key;
 const signature=f.r.authorization.signature;f.r.authorization.signature='A'.repeat(86)+'==';await assert.rejects(f.check(),e=>e.code==='signature');f.r.authorization.signature=signature;
 t.mock.timers.enable({apis:['Date'],now:f.r.authorization.expiresAt+1});await assert.rejects(f.check(),e=>e.code==='authorization-time');
});
test('missing installed files and symlink replacements remain violations',async t=>{
 const f=await fixture(t);await unlink(f.file);await assert.rejects(f.check(),e=>e.code==='package-missing'&&e.managedFile===f.file);
 const target=join(f.root,'external.rlplugin');await writeFile(target,f.bytes);
 try{await symlink(target,f.file,'file');}catch(e){if(e.code==='EPERM'){t.diagnostic('File symlink creation unavailable in this Windows token');return;}throw e;}
 await assert.rejects(f.check(),e=>e.code==='package-file');assert.deepEqual(await readFile(target),f.bytes);
});
