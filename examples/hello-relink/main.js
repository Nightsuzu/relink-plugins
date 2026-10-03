'use strict';
const statusElement=document.getElementById('status');
function render(state){statusElement.textContent=state.inVoice?`${state.roomName} · ${state.memberCount} 人`:state.connected?'已连接 Relink，尚未加入通话。':'尚未连接 Relink。';}
window.relinkPlugin.getState().then(render).catch(()=>{statusElement.textContent='暂时无法读取状态。';});
const unsubscribe=window.relinkPlugin.onState(render);
document.getElementById('show').addEventListener('click',()=>{window.relinkPlugin.action('show').catch(()=>{statusElement.textContent='暂时无法返回主窗口。';});});
addEventListener('pagehide',unsubscribe,{once:true});
