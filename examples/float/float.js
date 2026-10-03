'use strict';
const bridge = window.relinkPlugin, $ = id => document.getElementById(id);
const card = $('island'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
let followSystemMotion = true;
const reduceMotion = () => followSystemMotion && reduced.matches;
window.floatReduceMotion = reduceMotion;
function syncMotionPolicy() {
  document.documentElement.classList.toggle('reduce-motion', reduceMotion());
  document.documentElement.classList.toggle('full-motion', !followSystemMotion);
}
syncMotionPolicy();
const presentationAware = typeof bridge.getPresentation === 'function';
card.classList.toggle('legacy', !presentationAware);
let expanded = false, gameMode = false, hovered = false, topInset = presentationAware ? 18 : 8, epoch = 0, lastState = {}, pending = null;
let hoverAllowed = true;
let displayState = 'compact', headerTimer, autoViewTimer, headerAnimation, leaveTimer, hoverBlocked = false;
let pointerPosition = null;
window.floatHeaderExpanded = false;
let notchTransparency=15;try{notchTransparency=Math.max(0,Math.min(85,Number(localStorage.getItem('notch-transparency') ?? 15)||0));}catch{}
function applyPluginSettings(value){
  if(typeof value.followSystemMotion==='boolean' && followSystemMotion!==value.followSystemMotion){followSystemMotion=value.followSystemMotion;motionPreferenceChanged();}
  if(Number.isFinite(value.notchTransparency)){notchTransparency=value.notchTransparency;$('notch-opacity').value=String(notchTransparency);$('notch-opacity-value').textContent=notchTransparency+'%';morph();}
}
let frame = 0, previousTime = 0, animationTime = 0, disposed = false;
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
  animationTime += dt * 1000;
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
  // Count rendered spring time, not wall time: a delayed first frame after
  // occlusion or a busy GPU must not turn the entire morph into an instant cut.
  if (resting || animationTime >= 540) settle();
  else { paint(); frame = requestAnimationFrame(step); }
}
function morph() {
  const notch = displayState === 'notch';
  target = expanded ? [384,presentationAware ? (typeof bridge.getMedia === 'function' ? 372 : 232) : 184,28,gameMode ? 0 : topInset] : notch ? [188,28,14,0] : [304,58,29,gameMode ? 0 : topInset];
  target.push(expanded ? 1 : notch ? 1-notchTransparency/100 : hovered ? .97 : .88);
  target.push(expanded?28:notch?0:29);
  previousTime = performance.now(); animationTime = 0;
  if (reduceMotion()) { cancelAnimationFrame(frame); frame = 0; settle(); }
  else if (!frame) frame = requestAnimationFrame(step);
}
function headerMode(mode) {
  clearTimeout(headerTimer);
  const header = $('header'), opacity = Number(getComputedStyle(header).opacity);
  headerAnimation?.cancel(); window.floatHeaderChanging = true;
  const update = () => {
    card.classList.toggle('notch', mode === 'notch');
    card.classList.toggle('header-expanded', mode === 'expanded');
    header.style.width = (mode === 'notch' ? 186 : 302) + 'px';
    window.floatHeaderExpanded = mode === 'expanded'; window.floatHeaderChanging = false;
    window.floatRefreshSummary?.();
    headerAnimation?.cancel();
    if (!reduceMotion()) headerAnimation = header.animate([{opacity:0},{opacity:1}], {duration:180,delay:70,fill:'both',easing:'ease-out'});
  };
  if (reduceMotion()) update();
  else { headerAnimation = header.animate([{opacity},{opacity:0}], {duration:80,fill:'forwards',easing:'ease-out'}); headerTimer = setTimeout(update,80); }
}
function semantic(next) {
  expanded = next; card.classList.toggle('expanded', next);
  clearTimeout(autoViewTimer);
  if(!next) autoViewTimer = setTimeout(() => window.floatAutoView?.(), reduceMotion() ? 0 : 160);
  $('summary').setAttribute('aria-expanded', String(next));
  $('summary').setAttribute('aria-label', next ? '收起浮岛' : '展开浮岛');
  $('details').inert = !next; $('details').setAttribute('aria-hidden', String(!next));
  if (!next && $('details').contains(document.activeElement)) $('summary').focus({ preventScroll: true });
}
async function setExpanded(next) {
  return setDisplayState(next ? 'expanded' : gameMode ? 'notch' : 'compact');
}
async function setDisplayState(next) {
  if (next === displayState || (gameMode && !hoverAllowed && next !== 'notch')) return;
  clearTimeout(leaveTimer);
  const generation = ++epoch;
  const opening = next === 'expanded' || (displayState === 'notch' && next === 'compact');
  displayState = next; semantic(next === 'expanded'); headerMode(next);
  if (!opening) morph();
  try {
    if (bridge.setDisplayState) await bridge.setDisplayState(next);
    else await bridge.action(next === 'expanded' || (gameMode && next === 'compact') ? 'expand' : 'collapse');
    if (generation === epoch && opening) morph();
  } catch {
    if (generation !== epoch) return;
    displayState = gameMode ? 'notch' : 'compact'; semantic(false); headerMode(displayState); morph(); $('notice').textContent = '请返回 Relink 继续操作。';
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
function render(state) {
  const old = lastState; lastState = state;
  if (pending && (state[pending.key] === pending.expected || !state.connected || !state.inVoice)) clearPending();
  const status = !state.connected ? '连接中断' : state.deafened ? '耳机已关闭' : state.muted ? '麦克风已静音' : state.sharing ? '正在共享屏幕' : state.inVoice ? '通话中' : '在线 · 尚未加入通话';
  if (!window.floatHasMusic && !window.floatHeaderChanging) {
    $('room').textContent = state.inVoice ? state.roomName || '语音频道' : 'Relink';
    $('status').textContent = status;
  }
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
  window.floatRefreshSummary?.();
  if (old.inVoice && !state.inVoice && !window.floatHasMusic) void setExpanded(false);
}
function presentation(value) {
  const inset = Number.isFinite(value.topInset) ? Math.max(18,Math.min(128,value.topInset)) : 18;
  const allowed = value.hoverAllowed !== false;
  if (gameMode === (value.gameMode === true) && topInset === inset && hoverAllowed === allowed) return;
  const requireFreshHover = gameMode && !hoverAllowed;
  hoverAllowed = allowed;
  topInset = inset;
  gameMode = value.gameMode === true; ++epoch;
  clearTimeout(leaveTimer); hovered = false; hoverBlocked = false;
  pointerPosition = null;
  hoverBlocked = gameMode && (requireFreshHover || !hoverAllowed);
  displayState = gameMode ? 'notch' : 'compact'; headerMode(displayState);
  semantic(false); card.classList.toggle('game', gameMode);
  $('mode').textContent = gameMode ? '游戏模式 · 贴顶收起' : '通话随身，桌面留白';
  morph();
}
$('summary').addEventListener('click', () => void setExpanded(!expanded));
$('collapse').addEventListener('click', () => void setExpanded(false));
$('quick-mute').addEventListener('click', () => void action('mute'));
for (const id of ['mute','deafen','show']) $(id).addEventListener('click', () => void action(id));
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void setExpanded(false); } });
// Hover reveals only the compact island. Outside clicks dismiss immediately;
// the three-second grace period applies only to leaving without clicking.
function dismiss() { clearTimeout(leaveTimer); hoverBlocked = true; void setExpanded(false); }
card.addEventListener('pointerleave', () => { hovered = false; morph(); if (expanded || (gameMode && displayState === 'compact')) leaveTimer = setTimeout(() => void setExpanded(false), 3000); });
card.addEventListener('pointerenter', () => { hovered = true; clearTimeout(leaveTimer); if(gameMode && hoverAllowed && displayState === 'notch' && !hoverBlocked) void setDisplayState('compact'); else morph(); });
card.addEventListener('pointermove', event => {
  const position = `${event.screenX},${event.screenY}`;
  // Native canvas contraction can synthesize leave/enter without moving the
  // pointer. Only fresh pointer movement rearms hover after an outside click.
  if (hoverAllowed && hoverBlocked && pointerPosition !== null && position !== pointerPosition) {
    hoverBlocked = false;
    if (gameMode && displayState === 'notch') void setDisplayState('compact');
  }
  pointerPosition = position;
});
document.addEventListener('pointerdown', event => { if (expanded && !card.contains(event.target)) dismiss(); });
const offDismiss = bridge.onDismiss?.(dismiss);
$('notch-opacity').value=String(notchTransparency);$('notch-opacity-value').textContent=notchTransparency+'%';
$('notch-opacity').addEventListener('input',()=>{notchTransparency=Number($('notch-opacity').value);$('notch-opacity-value').textContent=notchTransparency+'%';morph();});
$('notch-opacity').addEventListener('change',()=>{if(bridge.updateSettings)void bridge.updateSettings({notchTransparency}).catch(()=>{$('notice').textContent='设置未保存，请稍后重试';});else try{localStorage.setItem('notch-transparency',String(notchTransparency));}catch{}});
function motionPreferenceChanged() {
  syncMotionPolicy();
  if (reduceMotion()) { document.getAnimations().forEach(a=>a.cancel()); headerMode(displayState); }
  morph();
}
reduced.addEventListener('change', motionPreferenceChanged);
const offState = bridge.onState(render), offPresentation = bridge.onPresentation?.(presentation);
const offSettings=bridge.onSettings?.(applyPluginSettings);bridge.getSettings?.().then(applyPluginSettings).catch(()=>{});
paint();
bridge.getState().then(render).catch(() => render(lastState));
bridge.getPresentation?.().then(presentation).catch(() => {});
window.addEventListener('pagehide', () => { disposed = true; cancelAnimationFrame(frame); clearTimeout(leaveTimer); clearTimeout(headerTimer); clearTimeout(autoViewTimer); headerAnimation?.cancel(); clearPending(); offState(); offPresentation?.(); offSettings?.(); offDismiss?.(); reduced.removeEventListener('change', motionPreferenceChanged); }, { once:true });
