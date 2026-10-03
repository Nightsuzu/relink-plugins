'use strict';
const bridge = window.relinkPlugin, $ = id => document.getElementById(id);
const card = $('island'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
const presentationAware = typeof bridge.getPresentation === 'function';
card.classList.toggle('legacy', !presentationAware);
let expanded = false, gameMode = false, hovered = false, topInset = presentationAware ? 18 : 8, epoch = 0, lastState = {}, pending = null;
let notchTransparency=15;try{notchTransparency=Math.max(0,Math.min(85,Number(localStorage.getItem('notch-transparency') ?? 15)||0));}catch{}
function applyPluginSettings(value){if(Number.isFinite(value.notchTransparency)){notchTransparency=value.notchTransparency;$('notch-opacity').value=String(notchTransparency);$('notch-opacity-value').textContent=notchTransparency+'%';morph();}}
let frame = 0, previousTime = 0, started = 0, disposed = false;
// A small analytical spring preserves velocity on reversal. It runs only during
// a morph; no idle loop, native resize per frame, blur pass or third-party runtime.
const values = [304, 58, 29, topInset, .88, 29], velocity = [0, 0, 0, 0, 0, 0];
let target = [...values];
function paint() {
  for (const [i, key] of ['--w','--h','--r','--top'].entries()) card.style.setProperty(key, `${values[i]}px`);
  card.style.setProperty('--surface-opacity', String(Math.max(0,Math.min(1,values[4]))));
  card.style.setProperty('--tr',Math.max(0,values[5])+'px');
}
function settle() { values.splice(0, values.length, ...target); velocity.fill(0); paint(); }
function step(time) {
  frame = 0; if (disposed) return;
  const dt = Math.min((time - previousTime) / 1000, .05); previousTime = time;
  const damping = 19, frequency = Math.sqrt(500 - damping * damping);
  const decay = Math.exp(-damping * dt), sin = Math.sin(frequency * dt), cos = Math.cos(frequency * dt);
  let resting = true;
  for (let i = 0; i < values.length; i++) {
    const displacement = values[i] - target[i], b = (velocity[i] + damping * displacement) / frequency;
    values[i] = target[i] + decay * (displacement * cos + b * sin);
    velocity[i] = decay * ((b * frequency - damping * displacement) * cos - (displacement * frequency + damping * b) * sin);
    const epsilon = i === 4 ? .0005 : .08;
    if (Math.abs(values[i] - target[i]) > epsilon || Math.abs(velocity[i]) > epsilon * 10) resting = false;
  }
  if (resting || time - started >= 540) settle();
  else { paint(); frame = requestAnimationFrame(step); }
}
function morph() {
  target = expanded ? [384,presentationAware ? (typeof bridge.getMedia === 'function' ? 372 : 232) : 184,28,gameMode ? 0 : topInset] : gameMode ? [188,28,14,0] : [304,58,29,topInset];
  target.push(expanded ? 1 : gameMode ? 1-notchTransparency/100 : hovered ? .97 : .88);
  target.push(expanded?28:gameMode?0:29);
  started = previousTime = performance.now();
  if (reduced.matches) { cancelAnimationFrame(frame); frame = 0; settle(); }
  else if (!frame) frame = requestAnimationFrame(step);
}
function semantic(next) {
  expanded = next; if(!next)window.floatAutoView?.(); card.classList.toggle('expanded', next);
  window.floatRefreshSummary?.();
  $('summary').setAttribute('aria-expanded', String(next));
  $('summary').setAttribute('aria-label', next ? '收起浮岛' : '展开浮岛');
  $('details').inert = !next; $('details').setAttribute('aria-hidden', String(!next));
  if (!next && $('details').contains(document.activeElement)) $('summary').focus({ preventScroll: true });
}
async function setExpanded(next) {
  if (next === expanded) return;
  const generation = ++epoch;
  semantic(next);
  if (!next) morph();
  try {
    await bridge.action(next ? 'expand' : 'collapse');
    if (generation === epoch && next) morph();
  } catch {
    if (generation !== epoch) return;
    semantic(false); morph(); $('notice').textContent = '请返回 Relink 继续操作。';
  }
}
function clearPending() { if (pending) clearTimeout(pending.timer); pending = null; }
async function action(name) {
  if (pending || (name !== 'show' && (!lastState.connected || !lastState.inVoice))) return;
  $('notice').textContent = '';
  if (name !== 'show') {
    const key = name === 'mute' ? 'muted' : 'deafened';
    pending = { key, expected: !lastState[key], timer: setTimeout(() => { clearPending(); render(lastState); $('notice').textContent = '状态尚未确认，请返回通话查看。'; }, 2500) };
    render(lastState);
  }
  try { await bridge.action(name); if (name === 'show') void setExpanded(false); }
  catch { clearPending(); render(lastState); $('notice').textContent = '暂时无法操作，请返回通话。'; }
}
let changeAnimation;
function render(state) {
  const old = lastState; lastState = state;
  if (pending && (state[pending.key] === pending.expected || !state.connected || !state.inVoice)) clearPending();
  const status = !state.connected ? '连接中断' : state.deafened ? '耳机已关闭' : state.muted ? '麦克风已静音' : state.sharing ? '正在共享屏幕' : state.inVoice ? '通话中' : '在线 · 尚未加入通话';
  const changed = $('status').textContent !== status;
  $('room').textContent = state.inVoice ? state.roomName || '语音频道' : 'Relink';
  $('status').textContent = status;
  $('count').textContent = state.inVoice ? `${state.memberCount} 人在通话` : '加入频道后可使用通话控制';
  $('share').hidden = !state.sharing || !state.connected;
  for (const [id, flag] of [['mute',state.muted],['quick-mute',state.muted],['deafen',state.deafened]]) {
    $(id).setAttribute('aria-pressed', String(Boolean(flag)));
    $(id).disabled = Boolean(pending) || !state.connected || !state.inVoice;
  }
  for (const id of ['mute','quick-mute']) $(id).setAttribute('aria-label', state.muted ? '取消麦克风静音' : '麦克风静音');
  $('deafen').setAttribute('aria-label', state.deafened ? '开启耳机' : '关闭耳机');
  $('mute-label').textContent = state.muted ? '取消静音' : '麦克风';
  $('deafen-label').textContent = state.deafened ? '开启耳机' : '耳机';
  if (changed && !reduced.matches) {
    changeAnimation?.cancel();
    changeAnimation = card.querySelector('.copy').animate([{ opacity:.45,transform:'translateY(2px)' },{ opacity:1,transform:'translateY(0)' }], { duration:240,easing:'ease-out' });
  }
  window.floatRefreshSummary?.();
  if (old.inVoice && !state.inVoice && !window.floatHasMusic) void setExpanded(false);
}
function presentation(value) {
  const inset = Number.isFinite(value.topInset) ? Math.max(18,Math.min(128,value.topInset)) : 18;
  if (gameMode === (value.gameMode === true) && topInset === inset) return;
  topInset = inset;
  gameMode = value.gameMode === true; ++epoch;
  semantic(false); card.classList.toggle('game', gameMode);
  $('mode').textContent = gameMode ? '游戏模式 · 贴顶收起' : '通话随身，桌面留白';
  morph();
}
$('summary').addEventListener('click', () => void setExpanded(!expanded));
$('collapse').addEventListener('click', () => void setExpanded(false));
$('quick-mute').addEventListener('click', () => void action('mute'));
for (const id of ['mute','deafen','show']) $(id).addEventListener('click', () => void action(id));
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void setExpanded(false); } });
// Leaving starts one cancellable 3-second contraction in every presentation mode.
let leaveTimer;
card.addEventListener('pointerleave', () => { hovered = false; morph(); if (expanded) leaveTimer = setTimeout(() => void setExpanded(false), 3000); });
card.addEventListener('pointerenter', () => { hovered = true; clearTimeout(leaveTimer); if(gameMode&&!expanded)void setExpanded(true);else morph(); });
$('notch-opacity').value=String(notchTransparency);$('notch-opacity-value').textContent=notchTransparency+'%';
$('notch-opacity').addEventListener('input',()=>{notchTransparency=Number($('notch-opacity').value);$('notch-opacity-value').textContent=notchTransparency+'%';morph();});
$('notch-opacity').addEventListener('change',()=>{if(bridge.updateSettings)void bridge.updateSettings({notchTransparency}).catch(()=>{$('notice').textContent='设置未保存，请稍后重试';});else try{localStorage.setItem('notch-transparency',String(notchTransparency));}catch{}});
function motionPreferenceChanged() { if (reduced.matches) changeAnimation?.cancel(); morph(); }
reduced.addEventListener('change', motionPreferenceChanged);
const offState = bridge.onState(render), offPresentation = bridge.onPresentation?.(presentation);
const offSettings=bridge.onSettings?.(applyPluginSettings);bridge.getSettings?.().then(applyPluginSettings).catch(()=>{});
paint();
bridge.getState().then(render).catch(() => render(lastState));
bridge.getPresentation?.().then(presentation).catch(() => {});
window.addEventListener('pagehide', () => { disposed = true; cancelAnimationFrame(frame); clearTimeout(leaveTimer); clearPending(); changeAnimation?.cancel(); offState(); offPresentation?.(); offSettings?.(); reduced.removeEventListener('change', motionPreferenceChanged); }, { once:true });
