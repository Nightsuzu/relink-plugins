'use strict';
(() => {
  const b=window.relinkPlugin,el=id=>document.getElementById(id),island=el('island');
  if(!b.getMedia)return;
  const names={qqmusic:'QQ 音乐',netease:'网易云音乐',soda:'汽水音乐'};
  let snapshot={sessions:[]},manual=false,view='voice',track=null,polling=null,pending=0,closed=false,channelBusy=false,channelState={scope:'',channels:[]},lastChannels='',lyricsKey='',trackKey='';
  let light=true;try{light=localStorage.getItem('orbit')!=='off';}catch{}
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  island.classList.toggle('light-on',light);el('light').setAttribute('aria-pressed',String(light));
  function applySettings(value){if(typeof value.orbit==='boolean'){light=value.orbit;island.classList.toggle('light-on',light);el('light').setAttribute('aria-pressed',String(light));el('light').setAttribute('aria-label',light?'关闭环绕光效':'开启环绕光效');}}
  const offSettings=b.onSettings?.(applySettings);b.getSettings?.().then(applySettings).catch(()=>{});
  function show(name,user=false){
    if(user)manual=true;view=name;
    for(const button of document.querySelectorAll('[data-view]'))button.setAttribute('aria-pressed',String(button.dataset.view===name));
    for(const name of ['music','voice','channels'])el('view-'+name).hidden=name!==view;
    if(name==='channels')void channels();
  }
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{if(manual&&view===button.dataset.view){manual=false;show(track?'music':'voice');}else show(button.dataset.view,true);};
  window.floatAutoView=()=>{manual=false;show(track||snapshot.activeSource?'music':'voice');};
  function message(value){el('notice').textContent=value;}
  function animate(element){if(motion.matches)return;element.getAnimations().forEach(a=>a.cancel());element.animate([{opacity:.35,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],{duration:230,easing:'cubic-bezier(.2,.8,.2,1)'});}
  function summary(){
    if(window.floatHeaderChanging)return;
    const has=!!track;window.floatHasMusic=has;island.classList.toggle('has-music',has);island.classList.toggle('music-cover',!!track?.cover);island.classList.toggle('playing',!!track?.playing);
    const image=el('compact-cover');image.hidden=!track?.cover;if(track?.cover&&image.getAttribute('src')!==track.cover)image.src=track.cover;
    const expanded=window.floatHeaderExpanded===true,icon=el('player-icon');
    icon.hidden=!has||!expanded||!['qqmusic','netease'].includes(track?.source);
    if(!icon.hidden){const src='player-'+track.source+'.png';if(icon.getAttribute('src')!==src)icon.src=src;}
    image.hidden=!track?.cover||expanded;el('compact-progress').hidden=!has||expanded;
    if(has){el('room').textContent=expanded?names[track.source]:track.title;if(expanded)el('status').textContent=track.playing?'正在播放':'已暂停';tick();}
    else if(snapshot.activeSource){el('room').textContent=names[snapshot.activeSource];el('status').textContent='等待播放器提供歌曲信息';}
    else {el('room').textContent=lastState.inVoice ? lastState.roomName || '语音频道' : 'Relink';el('status').textContent=!lastState.connected?'连接中断':lastState.inVoice?'通话中':'在线 · 尚未加入通话';}
  }
  window.floatRefreshSummary=summary;
  function render(){
    const source=snapshot.activeSource||track?.source||snapshot.sessions[0]?.source;
    track=snapshot.sessions.find(t=>t.source===source)||null;
    if(!manual)show(track||snapshot.activeSource?'music':'voice');
    el('auto-context').textContent=track ? '音乐已识别' : '自动识别';
    if(!track){island.classList.remove('has-music','playing');el('compact-cover').hidden=true;window.floatHasMusic=false;}
    summary();
    el('music-content').hidden=!track;el('music-empty').hidden=!!track;
    el('players').textContent='';
    if(!track){el('music-empty').querySelector('strong').textContent=snapshot.available===false?'音乐连接暂不可用':snapshot.activeSource?'等待 '+names[snapshot.activeSource]+' 的媒体信息':'让音乐靠近一点';return;}
    const identity=track.id+track.track;
    if(identity!==trackKey){trackKey=identity;lyricsKey='';el('track-title').textContent=track.title;el('track-artist').textContent=track.artist||'未知艺术家';animate(el('music-content'));}
    const cover=el('cover');cover.hidden=!track.cover;el('no-cover').hidden=!!track.cover;
    if(track.cover&&cover.getAttribute('src')!==track.cover)cover.src=track.cover;
    for(const action of ['previous','next']){el(action).disabled=!track.controls[action];el(action).title=track.controls[action]?'':names[track.source]+'未开放此控制';}
    const playAction=track.playing?'pause':'play';el('play-pause').disabled=!track.controls[playAction];el('play-pause').setAttribute('aria-label',track.playing?'暂停':'播放');el('play-path').setAttribute('d',track.playing?'M9 5v14M16 5v14':'m9 5 11 7-11 7Z');
    tick();
  }
  function time(ms){const s=Math.floor(ms/1000);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
  function tick(){
    if(!track)return;const elapsed=track.playing&&track.durationMs>0?Math.min(2500,Math.max(0,Date.now()-snapshot.updatedAt)):0;
    const position=Math.min(track.durationMs||86400000,track.positionMs+elapsed);
    el('elapsed').textContent=track.durationMs?time(position):'--:--';el('duration').textContent=track.durationMs?time(track.durationMs):'进度未提供';el('progress').value=track.durationMs?position/track.durationMs:0;
    const lines=track.lyrics?.lines||[];let index=-1;for(let i=0;i<lines.length&&lines[i].time<=position;i++)index=i;
    const status=track.lyrics?.status,now=index>=0?lines[index].text:status==='instrumental'?'纯音乐 · 静静聆听':status==='loading'?'正在匹配歌词':status==='synced'?'前奏':status==='disabled'?'歌词权限未开启':'暂无匹配的同步歌词';
    el('compact-progress').value=track.durationMs?position/track.durationMs:0;
    if(!window.floatHeaderChanging&&!window.floatHeaderExpanded)el('status').textContent=now;
    const next=lines[index+1]?.text||'';const key=now+'\n'+next;
    if(key!==lyricsKey){lyricsKey=key;el('lyric-now').textContent=now;el('lyric-next').textContent=next;animate(el('lyric'));}
  }
  function poll(){
    if(closed)return Promise.resolve();if(polling)return polling;
    polling=(async()=>{try{snapshot=await b.getMedia();if(!closed)render();}catch{message('音乐暂未连接，可稍后重试');}finally{polling=null;}})();return polling;
  }
  async function control(action){
    if(!track||pending>=3)return;const target={session:track.id,action};pending++;message('');
    el('play-pause').setAttribute('aria-busy','true');
    try{await b.controlMedia(target);await poll();setTimeout(()=>void poll(),120);setTimeout(()=>void poll(),350);}
    catch{message('播放器暂未执行操作，请再试一次');}
    finally{pending--;el('play-pause').setAttribute('aria-busy',String(pending>0));render();}
  }
  el('play-pause').onclick=()=>control(track?.playing?'pause':'play');
  for(const action of ['previous','next'])el(action).onclick=()=>control(action);
  el('light').onclick=()=>{applySettings({orbit:!light});if(b.updateSettings)void b.updateSettings({orbit:light}).catch(()=>message('设置未保存，请稍后重试'));else try{localStorage.setItem('orbit',light?'on':'off');}catch{}};
  async function channels(){
    if(closed||channelBusy)return;try{channelState=await b.getChannels();const key=JSON.stringify(channelState);if(key===lastChannels)return;lastChannels=key;
      el('channels').replaceChildren();el('channel-empty').hidden=!!channelState.channels.length;
      for(const c of channelState.channels){const button=document.createElement('button'),label=document.createElement('span'),state=document.createElement('small');label.textContent=c.name;state.textContent=c.current?'通话中':c.locked?'需密码':'加入';button.append(label,state);button.disabled=c.locked||c.current;button.setAttribute('aria-current',String(c.current));button.onclick=()=>switchTo(c);el('channels').append(button);}
    }catch{message('频道列表暂不可用');}
  }
  async function switchTo(c){if(channelBusy)return;channelBusy=true;message('正在连接 '+c.name);for(const button of el('channels').children)button.disabled=true;
    try{await b.switchChannel({scope:channelState.scope,id:c.id});message('已进入 '+c.name);}catch{message('尚未切换，请返回 Relink 查看');}
    finally{channelBusy=false;lastChannels='';await channels();}
  }
  let timer;
  async function schedule(){await poll();if(view==='channels')void channels();if(!closed)timer=setTimeout(schedule,island.classList.contains('expanded')?250:track?.playing?650:1200);}
  const timeline=setInterval(tick,250);void schedule();
  void poll();
  window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);clearInterval(timeline);offSettings?.();delete window.floatRefreshSummary;delete window.floatAutoView;},{once:true});
})();
