'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {inspectPackage,authorizePackage,verifyPackage,pluginSettings}=require('../runtime/package.cjs');
const settings=[{key:'orbit',label:'环绕光效',type:'toggle',default:true},{key:'opacity',label:'透明度',type:'range',min:0,max:85,step:5,default:15}];
const make=()=>({format:1,manifest:{id:'test-settings',name:'Test',description:'',version:'1.0.0',apiVersion:1,entry:'index.html',capabilities:[],author:{name:'Nightsuzu',avatar:'author.png'},settings:structuredClone(settings)},files:{'index.html':Buffer.from('<html></html>').toString('base64'),'author.png':Buffer.from('test avatar').toString('base64')}});
test('settings defaults, partial updates and invalid persisted values are bounded',()=>{
 const m=make().manifest;
 assert.deepEqual(pluginSettings(m),{orbit:true,opacity:15});
 assert.deepEqual(pluginSettings(m,{orbit:false,opacity:45},{opacity:80}),{orbit:false,opacity:80});
 assert.deepEqual(pluginSettings(m,{orbit:'true',opacity:99,unknown:1}),{orbit:true,opacity:15});
 for(const patch of [{unknown:1},{opacity:86},{opacity:42},{orbit:1},null,[]])assert.throws(()=>pluginSettings(m,{},patch));
 const first=pluginSettings(m,{}, {orbit:false});assert.equal(pluginSettings(m).orbit,true);assert.equal(first.orbit,false);
});
test('author identity, avatar bytes and settings schema are signed together',()=>{
 const pair=crypto.generateKeyPairSync('ed25519'),authority={keys:{test:pair.publicKey.export({type:'spki',format:'pem'})}};
 const signed=authorizePackage(JSON.stringify(make()),pair.privateKey,'test');assert.equal(verifyPackage(signed,authority).manifest.author.name,'Nightsuzu');
 for(const change of [p=>p.manifest.author.name='Other',p=>p.files['author.png']=Buffer.from('changed').toString('base64'),p=>p.manifest.settings[0].default=false]){const p=JSON.parse(signed);change(p);assert.throws(()=>verifyPackage(JSON.stringify(p),authority),e=>e.code==='authorization-binding');}
});
test('settings schemas reject duplicate keys, unsafe keys and invalid ranges',()=>{
 for(const change of [p=>p.manifest.settings.push(p.manifest.settings[0]),p=>p.manifest.settings[0].key='constructor',p=>p.manifest.settings[1].step=0,p=>p.manifest.settings[1].default=16,p=>p.manifest.author.avatar='../x.png',p=>p.manifest.author.avatar='missing.png']){const p=make();change(p);assert.throws(()=>inspectPackage(JSON.stringify(p)));}
});
