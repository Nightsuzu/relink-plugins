'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PluginPointer}=require('../host/plugin-pointer.cjs');
function fixture(){
 const timers=new Map(),children=[],cursors=[],points=[];let serial=0;
 const runtime={platform:'win32',findExecutable:()=>'/fixture/bridge.exe',spawn:()=>{
  const c=new EventEmitter();c.stdout=new EventEmitter();c.stdout.setEncoding=()=>{};c.kill=()=>{c.killed=true;c.emit('exit',1)};children.push(c);return c;
 },setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id)};
 const pointer=new PluginPointer(p=>points.push(p),c=>cursors.push(c),runtime);
 const fire=id=>{const t=timers.get(id);assert(t);timers.delete(id);t.fn()};
 return{pointer,timers,children,cursors,points,runtime,fire};
}
test('native helper exit disables interaction and restarts without reopening plugin',()=>{
 const f=fixture();try{
  f.pointer.start();const original=f.children[0];original.stdout.emit('data','CURSOR 1\nREADY\n');
  assert.equal(f.pointer.ready,true);assert.equal(f.cursors.at(-1),true);
  original.emit('exit',1);assert.equal(f.pointer.ready,false);assert.equal(f.cursors.at(-1),false);
  assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].ms,1000);
  f.fire(f.pointer.retryTimer);assert.equal(f.children.length,2);
  original.stdout.emit('data','CURSOR 1\n');assert.equal(f.cursors.at(-1),false,'obsolete child cannot re-enable input');
  f.children[1].stdout.emit('data','READY\nCURSOR 1\nDOWN -120 8\n');
  assert.equal(f.cursors.at(-1),true);assert.deepEqual(f.points,[{x:-120,y:8}]);
 }finally{f.pointer.stop()}
});
test('explicit plugin shutdown cancels retry and startup timeout',()=>{
 const f=fixture();f.pointer.start();f.children[0].emit('error',new Error('fixture'));
 f.pointer.stop();assert.equal(f.timers.size,0);assert.equal(f.pointer.running,false);
 f.children[0].emit('exit',1);assert.equal(f.timers.size,0);
 f.pointer.start();assert.equal(f.children.length,2);f.pointer.stop();assert.equal(f.timers.size,0);
});
test('unready helper times out; repeated failures back off to 30 seconds',()=>{
 const f=fixture();try{
  f.pointer.start();assert.equal(f.timers.get(f.pointer.readyTimer).ms,5000);
  f.fire(f.pointer.readyTimer);assert.equal(f.children[0].killed,true);
  const delays=[];
  for(let i=0;i<7;i++){delays.push(f.timers.get(f.pointer.retryTimer).ms);f.fire(f.pointer.retryTimer);f.children.at(-1).emit('exit',1)}
  assert.deepEqual(delays,[1000,2000,4000,8000,16000,30000,30000]);
 }finally{f.pointer.stop()}
});
test('spawn errors or missing binary recover and malformed output fails closed',()=>{
 const f=fixture();try{
  let available=false;f.pointer.findExecutable=()=>available?'/fixture/bridge.exe':null;
  f.pointer.start();assert.equal(f.children.length,0);assert(f.pointer.retryTimer);
  available=true;f.fire(f.pointer.retryTimer);assert.equal(f.children.length,1);
  f.children[0].stdout.emit('data','READY\nCURSOR 1\n');
  f.children[0].stdout.emit('data','x'.repeat(16385));assert.equal(f.cursors.at(-1),false);assert(f.pointer.retryTimer);
  f.pointer.spawn=()=>{throw new Error('spawn fixture')};f.fire(f.pointer.retryTimer);assert(f.pointer.retryTimer);
 }finally{f.pointer.stop()}
});
