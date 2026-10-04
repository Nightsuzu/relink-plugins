'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {mkdtemp,mkdir,rm}=require('node:fs/promises');
const {join,resolve,dirname}=require('node:path');
const {PluginHost}=require('../host/plugin-host.cjs');
const settle=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};

async function fixture(t) {
  await mkdir(resolve('.work'),{recursive:true});
  const directory=await mkdtemp(join(resolve('.work'),'plugin-runtime-'));
  await mkdir(join(directory,'authorized-plugins'));
  const windows=[],handlers=new Map(),metrics={workingSetSize:240000,privateBytes:48000};let checks=0;
  class Window extends EventEmitter {
    constructor(){super();windows.push(this);this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},setWindowOpenHandler(){},send(){},getOSProcessId:()=>300+windows.indexOf(this)});}
    isDestroyed(){return this.destroyed===true;} destroy(){this.destroyed=true;this.emit('closed');}
    setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setBounds(bounds){this.bounds=bounds;} getBounds(){return this.bounds||{x:0,y:0,width:320,height:74};} showInactive(){}
    async loadURL(url){this.webContents.mainFrame.url=url;}
  }
  const screen=new EventEmitter();Object.assign(screen,{getPrimaryDisplay:()=>({id:1,bounds:{x:0,y:0,width:1280,height:800},workArea:{x:0,y:0,width:1280,height:760}}),getAllDisplays:()=>[]});
  const host=new PluginHost({app:{getPath:()=>directory,getAppMetrics:()=>windows.filter(w=>!w.isDestroyed()).map(w=>({pid:w.webContents.getOSProcessId(),memory:{...metrics}}))},BrowserWindow:Window,session:{fromPartition:()=>({protocol:{handle:async()=>{},unhandle(){}},setPermissionCheckHandler(){},setPermissionRequestHandler(){},setDevicePermissionHandler(){},webRequest:{onBeforeRequest(){}},on(){},clearStorageData:async()=>{}})},screen,ipcMain:{handle:(k,v)=>handlers.set(k,v),on(){}},mediaService:{stop(){}},getWindow:()=>null,trustedIpc:()=>true});
  host.pointer={start(){},stop(){}};host.check=async()=>{checks++;};
  host.state={authenticated:true,connected:true,inVoice:true,muted:true};host.preferences.overlay={enabled:true};
  const record={manifest:{id:'overlay',name:'Runtime test',version:'0.3.4',apiVersion:2,entry:'index.html',capabilities:[]},assets:new Map(),file:join(host.root,'overlay.rlplugin'),error:null,window:null};
  host.records.set('overlay',record);host.register();await host.sync(record);
  t.after(async()=>{host.dispose();assert.equal(dirname(resolve(directory)),resolve('.work'));assert.match(directory,/plugin-runtime-/);await rm(directory,{recursive:true,force:true});});
  return{host,record,windows,metrics,handlers,checks:()=>checks};
}

test('a large shared working set does not pause a healthy plugin; sustained private allocations retain the cap',async t=>{
  const f=await fixture(t);
  await f.host.audit();await f.host.audit();assert.equal(f.record.error,null);assert.equal(f.windows.length,1);
  f.metrics.privateBytes=210000;await f.host.audit();assert.ok(f.record.window);
  f.metrics.privateBytes=48000;await f.host.audit();assert.equal(f.record.overBudget,0);
  f.metrics.privateBytes=210000;await f.host.audit();await f.host.audit();
  assert.equal(f.record.window,null);assert.equal(f.record.recovering,false);assert.match(f.record.error,/内存限额/);
  assert.equal(f.host.state.inVoice,true);
});
test('temporary unresponsive signals recover without a restart; a real stall restarts only the checked plugin',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=await fixture(t),first=f.record.window;
  first.webContents.emit('unresponsive');t.mock.timers.tick(5999);assert.equal(f.record.window,first);
  first.webContents.emit('responsive');t.mock.timers.tick(6000);assert.equal(f.windows.length,1);
  first.webContents.emit('unresponsive');t.mock.timers.tick(6000);assert.equal(f.record.window,null);assert.equal(f.host.list().plugins[0].status,'recovering');
  await f.host.sync(f.record);assert.equal(f.windows.length,1,'state publications cannot bypass recovery delay');
  t.mock.timers.tick(1000);await settle();assert.equal(f.windows.length,2);assert.equal(f.checks(),2);assert.equal(f.host.list().plugins[0].status,'active');
  assert.equal(f.host.state.inVoice,true);assert.equal(f.host.state.muted,true);
  first.webContents.emit('unresponsive');first.webContents.emit('render-process-gone',{}, {reason:'crashed'});
  t.mock.timers.tick(6000);assert.equal(f.windows.length,2);assert.equal(f.record.error,null,'retired-window events cannot kill its replacement');
});
test('crash retries are bounded, explicit re-enable retries, and disabling cancels a pending restart',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=await fixture(t);
  f.record.window.webContents.emit('render-process-gone',{}, {reason:'crashed'});t.mock.timers.tick(1000);await settle();
  f.record.window.webContents.emit('render-process-gone',{}, {reason:'crashed'});t.mock.timers.tick(2000);await settle();
  f.record.window.webContents.emit('render-process-gone',{}, {reason:'crashed'});t.mock.timers.tick(10000);await settle();
  assert.equal(f.windows.length,3);assert.equal(f.host.list().plugins[0].status,'failed');
  await f.handlers.get('relink:plugins:configure')({},'overlay',{enabled:true});assert.equal(f.windows.length,4);
  f.record.window.webContents.emit('render-process-gone',{}, {reason:'crashed'});
  await f.handlers.get('relink:plugins:configure')({},'overlay',{enabled:false});t.mock.timers.tick(10000);await settle();
  assert.equal(f.windows.length,4);assert.equal(f.record.window,null);assert.equal(f.record.recovering,false);
});
test('renderer OOM never enters an automatic crash loop',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=await fixture(t);
  f.record.window.webContents.emit('render-process-gone',{}, {reason:'oom'});t.mock.timers.tick(10000);await settle();
  assert.equal(f.windows.length,1);assert.equal(f.host.list().plugins[0].status,'failed');
});
