'use strict';
const {randomUUID}=require('node:crypto');
const {PluginMedia}=require('./plugin-media.cjs');
const {limiter}=require('./plugin-policy.cjs');
function cleanChannels(value) {
  if(!value||typeof value.scope!=='string'||value.scope.length>160)return {scope:'',channels:[]};
  return {scope:value.scope,channels:(Array.isArray(value.channels)?value.channels:[]).slice(0,100).filter(c=>c&&typeof c.id==='string'&&c.id.length<=160&&typeof c.name==='string').map(c=>({id:c.id,name:c.name.replace(/[\x00-\x1f]/g,'').slice(0,100),current:c.current===true,locked:c.locked===true}))};
}
class PluginServices {
  constructor(host,media) {this.host=host;this.media=media||new PluginMedia();this.channels={scope:'',channels:[]};this.pending=new Map();this.used=false;this.stopped=false;}
  register(plugin) {
    const h=this.host;
    const allow=(event,cap)=>{
      const r=plugin(event);if(!r||h.disposed||h.incident||!h.state.authenticated||!r.manifest.capabilities.includes(cap))throw new Error('未获授权的插件接口');
      const key=['music.control','channels.switch'].includes(cap)?'serviceActionLimit':'serviceReadLimit';
      r[key] ||= limiter(key==='serviceReadLimit'?24:8);if(!r[key]())throw new Error('操作过于频繁');return r;
    };
    h.ipcMain.handle('relink:plugin:media',async e=>{const r=allow(e,'music.read');this.used=true;return this.media.read(r.manifest.capabilities.includes('music.lyrics'));});
    h.ipcMain.handle('relink:plugin:media-control',async(e,v)=>{allow(e,'music.control');return this.media.control(v);});
    h.ipcMain.handle('relink:plugin:channels',e=>{allow(e,'channels.read');return h.state.connected?this.channels:{scope:'',channels:[]};});
    h.ipcMain.on('relink:plugins:channels',(e,v)=>{if(h.trustedIpc(e)&&!h.disposed&&!h.incident)this.channels=cleanChannels(v);});
    h.ipcMain.handle('relink:plugin:switch-channel',async(e,v)=>{
      const r=allow(e,'channels.switch');const channel=this.channels.channels.find(c=>c.id===v?.id);
      if(!h.state.connected||!channel||channel.locked||v.scope!==this.channels.scope)throw new Error('频道不可用，请返回 Relink 查看');
      if(channel.current)return;
      if(this.pending.size)throw new Error('正在切换频道');
      const w=h.getWindow();if(!w||w.isDestroyed())throw new Error('主窗口不可用');
      const id=randomUUID();await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('尚未确认频道状态，请返回 Relink 查看'));},10000);
        this.pending.set(id,{resolve,reject,timer,record:r});w.webContents.send('relink:plugins:switch-channel',{requestId:id,scope:v.scope,id:channel.id});
      });
    });
    h.ipcMain.on('relink:plugins:channel-result',(e,v)=>{
      if(!h.trustedIpc(e))return;const p=this.pending.get(v?.requestId);if(!p)return;
      this.pending.delete(v.requestId);clearTimeout(p.timer);v.ok===true?p.resolve():p.reject(new Error('未能切换频道，请返回 Relink 查看'));
    });
    this.timer=setInterval(()=>{
      if(this.used&&![...h.records.values()].some(r=>r.window&&r.manifest.capabilities.includes('music.read'))){this.media.stop();this.used=false;}
    },2500);this.timer.unref();
  }
  stop(){this.stopped=true;clearInterval(this.timer);this.media.stop();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('插件已停止'));}this.pending.clear();}
}
module.exports={PluginServices,cleanChannels};
