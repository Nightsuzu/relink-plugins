'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const SOURCES = new Set(['qqmusic','netease','soda']);
const text = (s, max=160) => typeof s === 'string' ? s.replace(/[\x00-\x1e\x7f]/g,'').slice(0,max) : '';
function sanitizeSessions(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0,6).filter(r => r && SOURCES.has(r.source) && /^media-\d{1,9}$/.test(r.id) && typeof r.track === 'string' && r.track.length <= 600).map(r => ({
    id:r.id,current:r.current===true,source:r.source,track:r.track,title:text(r.title),artist:text(r.artist),album:text(r.album),playing:r.playing===true,
    cover:typeof r.cover==='string' && r.cover.length<=220000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.cover) ? r.cover : '',
    durationMs:Math.max(0,Math.min(86400000,Number(r.durationMs)||0)),positionMs:Math.max(0,Math.min(86400000,Number(r.positionMs)||0)),
    controls:Object.fromEntries(['play','pause','next','previous'].map(k=>[k,r.controls?.[k]===true])),
  }));
}
// Process lifetime wins over playback state. A paused player keeps ownership.
function selectPlayer(players, sessions, previous) {
  if(!Array.isArray(players))return {source:previous?.source||sessions[0]?.source||'',started:0};
  const alive=players.filter(p=>SOURCES.has(p?.source)&&Number.isFinite(p.started)&&p.started>0);
  return alive.find(p=>p.source===previous?.source&&p.started===previous.started)
    ||alive.sort((a,b)=>a.started-b.started)[0]||null;
}
function parseLrc(raw) {
  if(typeof raw!=='string'||raw.length>150000)return [];
  const offset = Math.max(-30000,Math.min(30000,Number(raw.match(/\[offset:([+-]?\d+)\]/i)?.[1])||0));
  const lines=[];
  for(const line of raw.split(/\r?\n/).slice(0,3000)) {
    const label=line.replace(/\[[^\]]*\]/g,'').trim().slice(0,240); if(!label)continue;
    for(const match of line.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)) {
      const time=Math.max(0,Number(match[1])*60000+Number(match[2])*1000+Number((match[3]||'').padEnd(3,'0'))-offset);
      if(time<=86400000)lines.push({time,text:label}); if(lines.length>=2000)break;
    }
    if(lines.length>=2000)break;
  }
  return lines.sort((a,b)=>a.time-b.time);
}
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'');
function matchingLyrics(track, result) {
  return result && normalize(track.title)===normalize(result.trackName) && normalize(track.artist)===normalize(result.artistName) && track.durationMs>0 && Number.isFinite(result.duration) && Math.abs(track.durationMs/1000-result.duration)<=3 && (!track.album||!result.albumName||normalize(track.album)===normalize(result.albumName));
}
class NativeMedia {
  constructor(executable) { this.executable=executable;this.pending=new Map();this.serial=0;this.nextStart=0; }
  start() {
    if(this.child)return;
    if(Date.now()<this.nextStart||!this.executable||!fs.existsSync(this.executable))throw new Error('音乐桥接暂不可用');
    const child=spawn(this.executable,[],{windowsHide:true,stdio:['pipe','pipe','ignore']});this.child=child;let buffer='';
    const fail=()=>{ if(this.child!==child)return;this.child=null;this.nextStart=Date.now()+5000;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('播放器暂未响应'));}this.pending.clear();child.kill(); };
    child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>1500000){fail();return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let value;try{value=JSON.parse(line);}catch{fail();return;}const p=this.pending.get(value.id);if(!p)continue;this.pending.delete(value.id);clearTimeout(p.timer);value.ok?p.resolve(value):p.reject(new Error('播放器未响应或状态已改变'));}
    });
  }
  request(value) {
    if(this.pending.size>=2)return Promise.reject(new Error('请稍候'));
    try{this.start();}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{const id=++this.serial;const timer=setTimeout(()=>this.stop(),10000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...value,id})+'\n');});
  }
  stop(){const child=this.child;this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('音乐桥接已停止'));}this.pending.clear();child?.kill();}
}
class PluginMedia {
  constructor({ native,fetch:fetcher,executable }={}) {
    const packaged=path.join(process.resourcesPath||'', 'plugin-native','RelinkMediaBridge.exe');
    const development=path.join(__dirname,'../plugin-sdk/native/bin/RelinkMediaBridge.exe');
    this.native=native||new NativeMedia(executable||(fs.existsSync(packaged)?packaged:fs.existsSync(development)?development:path.join(__dirname,'../native/bin/RelinkMediaBridge.exe')));
    this.fetch=fetcher||((...args)=>require('electron').net.fetch(...args));this.cache=new Map();this.jobs=new Map();this.snapshot={available:true,sessions:[],updatedAt:0};this.generation=0;this.controlQueue=Promise.resolve();this.controlCount=0;
  }
  async read(lyrics=false) {
    if(!this.reading&&Date.now()-this.snapshot.updatedAt>100){
      const generation=this.generation;
      this.reading=this.native.request({op:'state'}).then(r=>{if(generation===this.generation){
        const sessions=sanitizeSessions(r.sessions);this.selectedPlayer=selectPlayer(r.players,sessions,this.selectedPlayer);
        this.snapshot={available:true,activeSource:this.selectedPlayer?.source||'',sessions:sessions.filter(s=>s.source===this.selectedPlayer?.source),updatedAt:Date.now()};
      }}).catch(()=>{if(generation===this.generation)this.snapshot={available:false,activeSource:this.selectedPlayer?.source||'',sessions:[],updatedAt:Date.now()};}).finally(()=>{this.reading=null;});
    }
    if(this.reading)await this.reading;
    if(lyrics) for(const track of this.snapshot.sessions) if(track.playing) void this.loadLyrics(track);
    return {...this.snapshot,sessions:this.snapshot.sessions.map(t=>({...t,lyrics:lyrics?(this.cache.get(t.track)||{status:t.playing?'loading':'idle',lines:[]}):{status:'disabled',lines:[]}}))};
  }
  async loadLyrics(track) {
    if(this.cache.has(track.track)||this.jobs.has(track.track)||this.jobs.size>=2)return;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);this.jobs.set(track.track,controller);
    const generation=this.generation;
    let result={status:'unavailable',lines:[]};
    try {
      if(!track.title||!track.artist||track.durationMs<=0)return;
      const params=new URLSearchParams({track_name:track.title,artist_name:track.artist,album_name:track.album,duration:String(Math.round(track.durationMs/1000))});
      const response=await this.fetch('https://lrclib.net/api/get?'+params,{signal:controller.signal,redirect:'error',credentials:'omit',headers:{'User-Agent':'Relink-Float/0.3.0 (https://relinkus.cn/plugins/)'}});
      if(!response.ok||Number(response.headers.get('content-length'))>200000)throw new Error('unavailable');
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>200000){controller.abort();throw new Error('oversize');}chunks.push(Buffer.from(chunk));}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(matchingLyrics(track,data)){
        const lines=parseLrc(data.syncedLyrics);result={status:data.instrumental?'instrumental':lines.length?'synced':'unavailable',lines,source:'LRCLIB'};
      }
    }catch{/* Lyrics failure never interrupts transport. */}
    finally{
      clearTimeout(timer);if(this.jobs.get(track.track)===controller)this.jobs.delete(track.track);
      if(generation===this.generation){this.cache.set(track.track,result);while(this.cache.size>24)this.cache.delete(this.cache.keys().next().value);}
    }
  }
  control(value) {
    if(!value||typeof value!=='object'||!['play','pause','previous','next'].includes(value.action))return Promise.reject(new Error('音乐操作无效'));
    // Transport buttons target a player session, not an obsolete title. Song
    // changes must not invalidate a user's next/pause command to that player.
    const track=this.snapshot.sessions.find(t=>t.id===value.session);
    if(!track)return Promise.reject(new Error('播放器已关闭'));
    if(this.controlCount>=3)return Promise.reject(new Error('请稍候'));
    this.controlCount++;
    const generation=this.generation;
    const run=this.controlQueue.then(async()=>{
      if(generation!==this.generation)throw new Error('音乐控制已停止');
      await this.native.request({op:'control',session:track.id,action:value.action});this.snapshot.updatedAt=0;
    });
    this.controlQueue=run.catch(()=>{});
    return run.finally(()=>{this.controlCount--;});
  }
  stop(){this.generation++;this.native.stop();for(const c of this.jobs.values())c.abort();this.jobs.clear();this.cache.clear();this.snapshot={available:true,sessions:[],updatedAt:0};}

}
module.exports={PluginMedia,NativeMedia,parseLrc,matchingLyrics,sanitizeSessions,selectPlayer};
