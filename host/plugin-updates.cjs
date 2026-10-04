'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_BYTES, verifyPackage, pluginSettings } = require('../runtime/package.cjs');
const ORIGIN = 'https://relinkus.cn';
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value) ? value.split('.').map(Number) : null;
function newer(a,b) { const x=version(a),y=version(b); if(!x||!y)return false;for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false; }
async function bounded(fetcher,url,limit) {
  const response=await fetcher(url,{cache:'no-store',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(25000)});
  if(!response.ok||Number(response.headers.get('content-length'))>limit)throw Error('插件下载暂不可用，请稍后重试。');
  let size=0;const parts=[];for await(const part of response.body){size+=part.length;if(size>limit)throw Error('插件数据超过大小限制。');parts.push(Buffer.from(part));}
  return Buffer.concat(parts);
}
class PluginUpdates {
  constructor(host,{fetch:fetcher}={}) { this.host=host;this.fetch=fetcher||((...args)=>require('electron').net.fetch(...args));this.status={checking:false,checkedAt:0,error:''};this.available=new Map();this.jobs=new Set(); }
  state(id) { return this.available.get(id)||null; }
  start() { this.initial=setTimeout(()=>void this.check().catch(()=>{}),30000);this.initial.unref();this.timer=setInterval(()=>void this.check().catch(()=>{}),300000+Math.floor(Math.random()*30000));this.timer.unref(); }
  stop() { this.stopped=true;clearTimeout(this.initial);clearInterval(this.timer); }
  async check({manual=false}={}) {
    if(this.checking)return this.checking;
    if(this.stopped)return this.host.list();
    this.checking=this.runCheck(manual).finally(()=>{this.checking=null;});return this.checking;
  }
  async runCheck(manual) {
    const h=this.host;
    this.status={...this.status,checking:true,error:''};h.notify();
    try {
      if(h.records.size){
        const data=JSON.parse((await bounded(this.fetch,ORIGIN+'/plugins-api/catalog',1024*1024)).toString('utf8'));
        if(!data.ok||!Array.isArray(data.result?.items)||data.result.items.length>500)throw Error('插件更新信息无效。');
        if(this.stopped)return h.list();
        for(const r of h.records.values()){
          const row=data.result.items.filter(v=>v?.status==='approved'&&v.manifest?.id===r.manifest.id&&/^[a-f0-9-]{36}$/.test(v.id)&&/^[a-f0-9]{64}$/.test(v.contentHash)&&newer(v.manifest.version,r.manifest.version)).sort((a,b)=>newer(a.manifest.version,b.manifest.version)?-1:1)[0];
          if(!this.jobs.has(r.manifest.id)) {
            if(row)this.available.set(r.manifest.id,{id:row.id,version:row.manifest.version,contentHash:row.contentHash,apiVersion:row.manifest.apiVersion,status:row.manifest.apiVersion>2?'client-required':'available',error:''});
            else this.available.delete(r.manifest.id);
          }
        }
      }
      this.status.checkedAt=Date.now();
    } catch(e) {this.status.error='暂时无法检查插件更新，请稍后重试。';if(manual)throw e;}
    finally {this.status.checking=false;h.notify();}
    return h.list();
  }
  async update(id,{automatic=false}={}) {
    const h=this.host,u=this.available.get(id),original=h.records.get(id);
    if(this.stopped||!original||!u||!['available','failed','permission-required'].includes(u.status))throw Error('没有可安装的插件更新。');
    if(this.jobs.has(id))return h.list();this.jobs.add(id);u.status='downloading';u.error='';h.notify();
    try {
      const bytes=await bounded(this.fetch,ORIGIN+'/plugins-api/download/'+u.id,MAX_BYTES);
      // Untrusted network failures never trigger the installed-plugin shutdown policy.
      let item;try {item=verifyPackage(bytes,h.authority);}catch {throw Error('下载的插件未通过授权校验，原插件未改变。');}
      if(item.manifest.id!==id||item.manifest.version!==u.version||item.contentHash!==u.contentHash||item.manifest.apiVersion>2)throw Error('插件版本或授权信息不匹配。');
      await h.serialize(async()=>{
        if(this.stopped||h.disposed||h.incident)throw Error('插件更新已停止。');
        const old=h.records.get(id);if(old!==original||old.removed||!newer(item.manifest.version,old.manifest.version))return;
        await h.check(old);
        const added=item.manifest.capabilities.filter(c=>!old.manifest.capabilities.includes(c));
        if(added.length){
          if(automatic){u.status='permission-required';return;}
          const options={type:'question',title:'插件新增权限',message:`${item.manifest.name} · v${item.manifest.version}`,detail:'这个版本新增以下权限：\n'+added.join('\n'),buttons:['允许并更新','暂不更新'],defaultId:1,cancelId:1,noLink:true};
          const main=h.getWindow(),answer=main&&!main.isDestroyed()?await h.dialog.showMessageBox(main,options):await h.dialog.showMessageBox(options);
          if(answer.response!==0){u.status='permission-required';return;}
        }
        if(this.stopped||h.disposed||h.incident)throw Error('插件更新已停止。');
        u.status='restarting';h.notify();
        const file=old.file,previous=file+'.previous',journal=file+'.pending.json',tmp=file+'.update';
        const pref=h.pref(id);let replaced=false;
        await fs.writeFile(tmp,bytes,{flag:'w'});
        try {
          await fs.copyFile(file,previous);
          await fs.writeFile(journal,JSON.stringify({id,previousHash:old.packageHash}),{flag:'w'});
          await h.release(old);await fs.rename(tmp,file);replaced=true;
          const record={...item,file,builtin:false,window:null,error:null};h.records.set(id,record);
          h.preferences[id]={...pref,settings:pluginSettings(item.manifest,pref.settings)};
          await h.sync(record);
          if(record.window)await new Promise(resolve=>setTimeout(resolve,350));
          if(record.error||this.stopped||h.disposed||h.incident)throw Error('新版插件未能启动。');
          await h.save();await fs.unlink(journal);
          await fs.unlink(previous).catch(()=>{});this.available.delete(id);
          this.status.message=`${item.manifest.name}已更新至 v${item.manifest.version}，Relink 保持运行。`;
        } catch(e) {
          await h.release(h.records.get(id));
          if(replaced)await fs.rename(previous,file);
          h.records.set(id,old);h.preferences[id]=pref;old.error=null;
          await h.save();await h.sync(old);
          await fs.unlink(journal).catch(()=>{});throw e;
        } finally {await fs.unlink(tmp).catch(()=>{});}
      });
    } catch(e) {u.status='failed';u.error='更新未完成，已保留原版本。请重试。';throw e;}
    finally {this.jobs.delete(id);h.notify();}
    return h.list();
  }
  async recover() {
    const h=this.host;
    for(const name of await fs.readdir(h.root)) {
      if(!/^[a-z][a-z0-9-]{2,63}\.rlplugin\.pending\.json$/.test(name))continue;
      const journal=path.join(h.root,name),file=journal.slice(0,-'.pending.json'.length);
      const stat=await fs.lstat(journal);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw Error('插件更新恢复记录无效。');
      const pending=JSON.parse(await fs.readFile(journal,'utf8')),old=await h.readPackage(file+'.previous');
      if(pending.id!==old.manifest.id||pending.previousHash!==old.packageHash||path.basename(file)!==old.manifest.id+'.rlplugin')throw Error('插件恢复校验失败。');
      await fs.rename(file+'.previous',file);await fs.unlink(journal);
      this.status.message='上次插件更新未完成，已恢复原版本。';
    }
  }
}
module.exports={PluginUpdates,newer,bounded};
