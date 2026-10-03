'use strict';
const bridge = window.relinkPlugin;
const byId = id => document.getElementById(id);
let expanded = false, lastState = {}, busy = false;
async function action(name) {
  if (busy) return;
  busy = true;
  try { await bridge.action(name); byId('notice').textContent = ''; }
  catch { byId('notice').textContent = '暂时无法操作，请返回 Relink。'; }
  finally { busy = false; }
}
async function setExpanded(next) {
  if (next === expanded) return;
  try { await bridge.action(next ? 'expand' : 'collapse'); }
  catch { return; }
  expanded = next;
  byId('details').hidden = !expanded;
  byId('summary').setAttribute('aria-expanded', String(expanded));
  byId('summary').setAttribute('aria-label', expanded ? '收起 Relink 灵动岛' : '展开 Relink 灵动岛');
  if (!expanded) byId('summary').focus({ preventScroll: true });
}
function render(state) {
  lastState = state;
  byId('room').textContent = state.inVoice ? state.roomName || '语音频道' : 'Relink';
  byId('status').textContent = !state.connected ? '连接已断开' : state.sharing ? '正在共享屏幕' : state.inVoice ? (state.deafened ? '已拒听' : state.muted ? '麦克风已静音' : '正在通话') : '在线 · 尚未加入通话';
  byId('count').textContent = state.inVoice ? `${state.memberCount} 人在通话${state.sharing ? ' · 屏幕共享中' : ''}` : '加入频道后，通话控制会在这里出现';
  byId('signal').className = `signal${!state.inVoice || !state.connected ? ' inactive' : state.muted ? ' muted' : ''}`;
  for (const [id, flag] of [['mute', state.muted], ['deafen', state.deafened]]) {
    byId(id).setAttribute('aria-pressed', String(flag));
    byId(id).disabled = !state.inVoice || !state.connected;
  }
  byId('mute').setAttribute('aria-label', state.muted ? '取消麦克风静音' : '麦克风静音');
  byId('deafen').setAttribute('aria-label', state.deafened ? '取消拒听' : '拒听');
}
byId('summary').addEventListener('click', () => void setExpanded(!expanded));
byId('collapse').addEventListener('click', () => void setExpanded(false));
for (const id of ['mute', 'deafen', 'show']) byId(id).addEventListener('click', () => void action(id));
document.addEventListener('keydown', event => { if (event.key === 'Escape') void setExpanded(false); });
bridge.onState(render);
bridge.getState().then(render).catch(() => render(lastState));
