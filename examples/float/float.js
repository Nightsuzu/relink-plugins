'use strict';
/*
 * Relink 浮岛 · 外壳
 *
 * 这个文件负责：形态（刘海 / 收起 / 展开）、弹簧动画、标题栏、视图切换、
 * 通话控制和插件设置。音乐与频道各在 media.js / channels.js 中，它们只通过
 * window.Float 与外壳通信，不直接改标题栏。
 *
 * 动画的三条约定（修复“变形时文字错位、闪一下”）：
 *   1. 只有一个时钟。外壳尺寸、标题栏尺寸、标题内容的淡入淡出、面板显隐
 *      全部在同一个 requestAnimationFrame 循环里推进，不再混用 setTimeout、
 *      Web Animations 和 CSS transition。
 *   2. 标题栏不再有“刘海布局 / 收起布局”两套离散样式。它的宽高每一帧都由
 *      外壳当前尺寸算出（--hw / --hh / --k），所以永远装在外壳里面。
 *   3. 标题内容（封面↔播放器图标、歌名↔播放器名）只在完全透明的那一帧替换。
 */
(() => {
  const bridge = window.relinkPlugin;
  const $ = id => document.getElementById(id);
  const island = $('island'), root = document.documentElement;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

  // ---------------------------------------------------------------- 事件
  const listeners = new Map();
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); };
  const emit = (name, value) => { for (const fn of listeners.get(name) || []) fn(value); };

  // ---------------------------------------------------------------- 状态
  // [宽, 高, 下圆角, 上圆角]；宿主的可点击区域按同样的数字裁剪，改这里要同步改宿主。
  const SHAPE = { notch: [188, 28, 14, 0], compact: [304, 58, 29, 29], expanded: [384, 372, 28, 28] };
  const HEADER = { minWidth: 186, maxWidth: 302, minHeight: 26, maxHeight: 56 };
  // 新宿主等实际动画完成后再裁剪；旧宿主保留 600 ms 兼容路径。
  const CLOSE_DEADLINE = 520;
  const trackedMorph = typeof bridge.completeDisplayTransition === 'function';
  const PLAYER_ICONS = new Set(['qqmusic', 'netease']);

  let mode = 'compact', gameMode = false, hoverAllowed = true, topInset = 18;
  let hovered = false, hoverBlocked = false, pointerPosition = null, leaveTimer = 0, epoch = 0, disposed = false;
  let voice = null, pendingAction = null;
  let music = null, coverSrc = '', coverReady = false;
  let view = 'voice';
  const settings = { followSystemMotion: true, orbit: true, notchTransparency: 15 };

  // ---------------------------------------------------------------- 动画策略
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const reduceMotion = () => settings.followSystemMotion && reduced.matches;
  function syncMotionPolicy() {
    root.classList.toggle('reduce-motion', reduceMotion());
    root.classList.toggle('full-motion', !settings.followSystemMotion);
  }

  // ---------------------------------------------------------------- 弹簧
  // 解析解的欠阻尼弹簧：反向时保留速度；只在变形期间运行，没有常驻循环。
  const DAMPING = 19, FREQUENCY = Math.sqrt(500 - DAMPING * DAMPING);
  const values = [304, 58, 29, topInset, .88, 29], velocity = [0, 0, 0, 0, 0, 0];
  let target = [...values];
  let frame = 0, lastTime = 0, firstFrame = false, deadline = Infinity;
  let closingElapsed = 0, closing = false, morph = null;
  function finishMorph() {
    if (!morph?.ready || !shapeResting()) return;
    const token = morph.token; morph = null;
    // Defer to the next paint so the native input shape never clips that frame.
    requestAnimationFrame(() => { void bridge.completeDisplayTransition(token).catch(() => {}); });
  }
  async function tellHost(next, token) {
    if (trackedMorph) morph = { token, ready:false };
    if (bridge.setDisplayState) await bridge.setDisplayState(next, trackedMorph ? token : undefined);
    else await bridge.action(next === 'expanded' || (gameMode && next === 'compact') ? 'expand' : 'collapse');
    if (morph?.token === token) morph.ready = true;
  }
  // 标题内容淡入淡出：fade 是不透明度，fadeDirection 为 -1 淡出、1 淡入、0 静止。
  let fade = 1, fadeDirection = 0;
  // 只有进出刘海时标题栏才跟着高度缩放；收起↔展开时固定 56 px，避免回弹带动文字。
  let notchBlend = false;

  function paint() {
    const [width, height, radius, top, surface, topRadius] = values, style = island.style;
    const headerHeight = notchBlend ? clamp(height - 2, HEADER.minHeight, HEADER.maxHeight) : HEADER.maxHeight;
    style.setProperty('--w', width + 'px');
    style.setProperty('--h', height + 'px');
    style.setProperty('--r', Math.max(0, radius) + 'px');
    style.setProperty('--tr', Math.max(0, topRadius) + 'px');
    style.setProperty('--top', top + 'px');
    style.setProperty('--surface', String(clamp(surface)));
    style.setProperty('--hw', clamp(width - 2, HEADER.minWidth, HEADER.maxWidth) + 'px');
    style.setProperty('--hh', headerHeight + 'px');
    style.setProperty('--k', String((headerHeight - HEADER.minHeight) / (HEADER.maxHeight - HEADER.minHeight)));
    style.setProperty('--d', String(clamp((height - 110) / 140)));
    style.setProperty('--fade', String(fade));
  }
  function settleShape() {
    values.splice(0, values.length, ...target); velocity.fill(0); deadline = Infinity;
    closing = false;
    if (mode !== 'notch') notchBlend = false;
  }
  function shapeResting() {
    for (let i = 0; i < values.length; i++) {
      const epsilon = i === 4 ? .0005 : .08;
      if (Math.abs(values[i] - target[i]) > epsilon || Math.abs(velocity[i]) > epsilon * 10) return false;
    }
    return true;
  }
  function step(time) {
    frame = 0; if (disposed) return;
    // 事件处理里取的 performance.now() 可能晚于本帧时间戳，dt 不能为负。
    let dt = Math.max(0, (time - lastTime) / 1000); lastTime = time;
    // 第一帧被调度或显卡拖慢时不跳过开头；之后每帧最多推进 50 ms。
    dt = Math.min(dt, firstFrame ? 1 / 60 : .05); firstFrame = false;
    if (closing) closingElapsed += dt * 1000;
    if (!shapeResting()) {
      const decay = Math.exp(-DAMPING * dt), sin = Math.sin(FREQUENCY * dt), cos = Math.cos(FREQUENCY * dt);
      for (let i = 0; i < values.length; i++) {
        const x = values[i] - target[i], b = (velocity[i] + DAMPING * x) / FREQUENCY;
        values[i] = target[i] + decay * (x * cos + b * sin);
        velocity[i] = decay * ((b * FREQUENCY - DAMPING * x) * cos - (x * FREQUENCY + DAMPING * b) * sin);
      }
      if (shapeResting() || (trackedMorph ? closing && closingElapsed >= CLOSE_DEADLINE : performance.now() >= deadline)) settleShape();
    } else if (deadline !== Infinity || notchBlend) settleShape();
    if (fadeDirection < 0) {
      fade = Math.max(0, fade - dt / .09);
      if (fade === 0) { writeHeader(desiredHeader()); fadeDirection = 1; }
    } else if (fadeDirection > 0) {
      fade = Math.min(1, fade + dt / .16);
      if (fade === 1) fadeDirection = 0;
    }
    paint();
    finishMorph();
    if (!shapeResting() || fadeDirection) frame = requestAnimationFrame(step);
  }
  function run() {
    if (reduceMotion()) {
      cancelAnimationFrame(frame); frame = 0; settleShape();
      if (fadeDirection) { writeHeader(desiredHeader()); fade = 1; fadeDirection = 0; }
      paint();
      finishMorph();
    } else if (!frame) { lastTime = performance.now(); firstFrame = true; frame = requestAnimationFrame(step); }
  }
  // closing: true = 收回（设期限），false = 放大（取消期限），不传 = 只是悬停或设置变化（保持原样）。
  // snap: 不做动画，直接到位。
  function retarget(closingRequest, snap = false) {
    const [width, height, radius, topRadius] = SHAPE[mode];
    const surface = mode === 'expanded' ? 1 : mode === 'notch' ? 1 - settings.notchTransparency / 100 : hovered ? .97 : .88;
    target = [width, height, radius, gameMode ? 0 : topInset, surface, topRadius];
    if (closingRequest === true) { deadline = performance.now() + CLOSE_DEADLINE; closingElapsed = 0; }
    else if (closingRequest === false) deadline = Infinity;
    // The renderer's elapsed time excludes a delayed first frame / focus stall.
    if (closingRequest !== undefined) closing = closingRequest;
    if (snap) {
      cancelAnimationFrame(frame); frame = 0; settleShape();
      writeHeader(desiredHeader()); fade = 1; fadeDirection = 0; paint();
    } else run();
  }

  // ---------------------------------------------------------------- 标题栏
  function voiceStatus() {
    if (!voice) return '正在同步通话';
    if (!voice.authenticated) return '尚未登录 Relink';
    if (!voice.connected) return '连接中断';
    if (!voice.inVoice) return '在线 · 尚未加入通话';
    return voice.deafened ? '耳机已关闭' : voice.muted ? '麦克风已静音' : voice.sharing ? '正在共享屏幕' : '通话中';
  }
  // 标题栏显示什么，只由这四个量决定：形态、当前视图、通话状态、音乐信息。
  function desiredHeader() {
    if (music && mode === 'expanded' && view === 'music') {
      return { head: 'player', lead: PLAYER_ICONS.has(music.source) ? music.source : 'brand', title: music.player, subtitle: music.playing ? '正在播放' : '已暂停', progress: null };
    }
    if (music && mode !== 'expanded') {
      return { head: 'track', lead: coverReady ? 'cover' : 'brand', title: music.title, subtitle: music.line, progress: music.progress };
    }
    return { head: 'voice', lead: 'brand', title: voice?.inVoice ? voice.roomName || '语音频道' : 'Relink', subtitle: voiceStatus(), progress: null };
  }
  let shown = null;
  function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
  function writeHeader(next) {
    shown = next;
    island.dataset.head = next.head; island.dataset.lead = next.lead;
    setText($('title'), next.title); setText($('subtitle'), next.subtitle);
    const bar = $('mini-progress');
    bar.hidden = next.progress === null;
    if (next.progress !== null) bar.value = next.progress;
  }
  function syncHeader() {
    if (fadeDirection < 0) return;                       // 正在淡出：等到全透明那一帧统一写入
    const next = desiredHeader();
    const sameLayout = shown && shown.head === next.head && shown.lead === next.lead;
    if (!shown || sameLayout || reduceMotion()) { writeHeader(next); return; }
    fadeDirection = -1; run();
  }

  // ---------------------------------------------------------------- 形态
  function applyMode(next) {
    if (mode === 'notch' || next === 'notch') notchBlend = true;
    mode = next; island.dataset.mode = next;
    const expanded = next === 'expanded', details = $('details'), summary = $('summary');
    summary.setAttribute('aria-expanded', String(expanded));
    summary.setAttribute('aria-label', expanded ? '收起浮岛' : '展开浮岛');
    details.inert = !expanded; details.setAttribute('aria-hidden', String(!expanded));
    if (!expanded && details.contains(document.activeElement)) summary.focus({ preventScroll: true });
    emit('mode', next);
  }
  const collapsedMode = () => gameMode ? 'notch' : 'compact';
  const setExpanded = next => setMode(next ? 'expanded' : collapsedMode());
  async function setMode(next) {
    if (next === mode || (gameMode && !hoverAllowed && next !== 'notch')) return;
    clearTimeout(leaveTimer);
    const generation = ++epoch;
    const opening = next === 'expanded' || (mode === 'notch' && next === 'compact');
    // 展开前选好视图：有音乐看音乐，否则看通话。展开期间不再自动跳转。
    if (next === 'expanded') showView(music ? 'music' : 'voice');
    applyMode(next);
    // 收回：先动画，宿主稍后再缩窗口。放大：等宿主把可绘制区域放大后再动，否则会被裁掉。
    if (!opening) { retarget(true); syncHeader(); }
    try {
      await tellHost(next, generation);
      if (generation === epoch && opening) { retarget(false); syncHeader(); }
      finishMorph();
    } catch {
      if (generation !== epoch) return;
      applyMode(collapsedMode()); retarget(true); syncHeader();
      notice('请返回 Relink 继续操作。');
    }
  }
  function presentation(value) {
    const inset = Number.isFinite(value.topInset) ? clamp(value.topInset, 18, 128) : 18;
    const allowed = value.hoverAllowed !== false, game = value.gameMode === true;
    if (game === gameMode && inset === topInset && allowed === hoverAllowed) return;
    const requireFreshHover = gameMode && !hoverAllowed;
    hoverAllowed = allowed; topInset = inset; gameMode = game; ++epoch;
    clearTimeout(leaveTimer); hovered = false; pointerPosition = null;
    hoverBlocked = gameMode && (requireFreshHover || !hoverAllowed);
    island.classList.toggle('game', gameMode);
    $('mode-hint').textContent = gameMode ? '游戏模式 · 贴顶收起' : '通话随身，桌面留白';
    // Input becomes click-through immediately; visuals may still finish smoothly.
    const snap = !trackedMorph && gameMode && !hoverAllowed && mode === 'compact';
    const next = collapsedMode();
    if (next !== mode) applyMode(next);
    retarget(true, snap); if (!snap) syncHeader();
    if (trackedMorph) void tellHost(next, epoch).then(finishMorph).catch(() => {});
  }

  // ---------------------------------------------------------------- 视图
  function showView(name) {
    if (view === name) return;
    view = name;
    for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === name));
    for (const id of ['music', 'voice', 'channels']) $('view-' + id).hidden = id !== name;
    notice('');
    syncHeader(); emit('view', name);
  }
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));

  // ---------------------------------------------------------------- 通话
  function notice(text) { setText($('notice'), text); }
  function clearPending() { if (pendingAction) clearTimeout(pendingAction.timer); pendingAction = null; }
  function renderVoice() {
    const state = voice, live = state.connected && state.inVoice;
    setText($('count'), state.inVoice ? `${state.memberCount} 人在通话` : '加入频道后可使用通话控制');
    $('share').hidden = !state.sharing || !state.connected;
    for (const [id, flag] of [['mute', state.muted], ['quick-mute', state.muted], ['deafen', state.deafened]]) {
      $(id).setAttribute('aria-pressed', String(Boolean(flag)));
      $(id).disabled = Boolean(pendingAction) || !live;
    }
    for (const id of ['mute', 'quick-mute']) $(id).setAttribute('aria-label', state.muted ? '取消麦克风静音' : '麦克风静音');
    $('deafen').setAttribute('aria-label', state.deafened ? '开启耳机' : '关闭耳机');
    setText($('mute-label'), state.muted ? '取消静音' : '麦克风');
    setText($('deafen-label'), state.deafened ? '开启耳机' : '耳机');
    syncHeader();
  }
  function onVoice(state) {
    const previous = voice; voice = state;
    if (pendingAction && (state[pendingAction.key] === pendingAction.expected || !state.connected || !state.inVoice)) clearPending();
    renderVoice(); emit('voice', state);
    if (previous?.inVoice && !state.inVoice && !music) void setExpanded(false);
  }
  async function action(name) {
    if (pendingAction || !voice || (name !== 'show' && (!voice.connected || !voice.inVoice))) return;
    notice('');
    if (name !== 'show') {
      const key = name === 'mute' ? 'muted' : 'deafened';
      pendingAction = { key, expected: !voice[key], timer: setTimeout(() => { clearPending(); renderVoice(); notice('状态尚未确认，请返回通话查看。'); }, 2500) };
      renderVoice();
    }
    try { await bridge.action(name); if (name === 'show') void setExpanded(false); }
    catch { clearPending(); renderVoice(); notice('暂时无法操作，请返回通话。'); }
  }

  // ---------------------------------------------------------------- 音乐（由 media.js 提供）
  // info: null 或 { source, player, title, line, cover, playing, progress }
  function setMusic(info) {
    music = info;
    island.classList.toggle('playing', Boolean(info?.playing));
    const cover = info?.cover || '';
    if (cover !== coverSrc) {
      coverSrc = cover;
      // 换歌时浏览器会保留旧封面直到新封面解码完成，所以这里不清 coverReady。
      if (cover) $('lead-cover').src = cover; else { coverReady = false; $('lead-cover').removeAttribute('src'); }
    }
    syncHeader();
  }
  $('lead-cover').addEventListener('load', () => { coverReady = true; syncHeader(); });
  $('lead-cover').addEventListener('error', () => { coverReady = false; syncHeader(); });

  // ---------------------------------------------------------------- 设置
  function renderSettings() {
    island.classList.toggle('light-on', settings.orbit);
    $('light').setAttribute('aria-pressed', String(settings.orbit));
    $('light').setAttribute('aria-label', settings.orbit ? '关闭环绕光效' : '开启环绕光效');
    $('notch-opacity').value = String(settings.notchTransparency);
    setText($('notch-opacity-value'), settings.notchTransparency + '%');
  }
  function applySettings(value) {
    if (!value) return;
    const motionBefore = reduceMotion();
    if (typeof value.followSystemMotion === 'boolean') settings.followSystemMotion = value.followSystemMotion;
    if (typeof value.orbit === 'boolean') settings.orbit = value.orbit;
    if (Number.isFinite(value.notchTransparency)) settings.notchTransparency = clamp(value.notchTransparency, 0, 85);
    syncMotionPolicy(); renderSettings();
    if (motionBefore !== reduceMotion() || mode === 'notch') retarget();
  }
  function saveSetting(key, value) {
    applySettings({ [key]: value });
    if (bridge.updateSettings) bridge.updateSettings({ [key]: value }).catch(() => notice('设置未保存，请稍后重试'));
  }
  $('light').addEventListener('click', () => saveSetting('orbit', !settings.orbit));
  // 拖动时只本地预览，松开后再保存（宿主限制写入频率）。
  $('notch-opacity').addEventListener('input', () => applySettings({ notchTransparency: Number($('notch-opacity').value) }));
  $('notch-opacity').addEventListener('change', () => saveSetting('notchTransparency', Number($('notch-opacity').value)));

  // ---------------------------------------------------------------- 交互
  $('summary').addEventListener('click', () => void setExpanded(mode !== 'expanded'));
  $('collapse').addEventListener('click', () => void setExpanded(false));
  $('quick-mute').addEventListener('click', () => void action('mute'));
  for (const id of ['mute', 'deafen', 'show']) $(id).addEventListener('click', () => void action(id));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void setExpanded(false); } });
  // 悬停只把刘海恢复成收起的浮岛；点外面立即收回；只移开不点击时保留 3 秒。
  function dismiss() { clearTimeout(leaveTimer); hoverBlocked = true; void setExpanded(false); }
  island.addEventListener('pointerleave', () => {
    hovered = false; retarget();
    if (mode === 'expanded' || (gameMode && mode === 'compact')) leaveTimer = setTimeout(() => void setExpanded(false), 3000);
  });
  island.addEventListener('pointerenter', () => {
    hovered = true; clearTimeout(leaveTimer);
    if (gameMode && hoverAllowed && mode === 'notch' && !hoverBlocked) void setMode('compact'); else retarget();
  });
  island.addEventListener('pointermove', event => {
    const position = `${event.screenX},${event.screenY}`;
    // 窗口区域收缩会合成一次移入事件；只有鼠标真的动了才重新允许悬停。
    if (hoverAllowed && hoverBlocked && pointerPosition !== null && position !== pointerPosition) {
      hoverBlocked = false;
      if (gameMode && mode === 'notch') void setMode('compact');
    }
    pointerPosition = position;
  });
  document.addEventListener('pointerdown', event => { if (mode === 'expanded' && !island.contains(event.target)) dismiss(); });

  // ---------------------------------------------------------------- 对外接口
  window.Float = Object.freeze({
    bridge, $, on, notice, setMusic, reduceMotion,
    get mode() { return mode; },
    get view() { return view; },
    get voice() { return voice; },
  });

  // ---------------------------------------------------------------- 启动 / 退出
  const motionChanged = () => { syncMotionPolicy(); retarget(); };
  reduced.addEventListener('change', motionChanged);
  const unsubscribe = [bridge.onState(onVoice), bridge.onPresentation?.(presentation), bridge.onSettings?.(applySettings), bridge.onDismiss?.(dismiss)];
  syncMotionPolicy(); renderSettings(); paint();
  bridge.getSettings?.().then(applySettings).catch(() => {});
  bridge.getState().then(onVoice).catch(() => {});
  bridge.getPresentation?.().then(presentation).catch(() => {});
  window.addEventListener('pagehide', () => {
    disposed = true; cancelAnimationFrame(frame); clearTimeout(leaveTimer); clearPending();
    for (const off of unsubscribe) off?.();
    reduced.removeEventListener('change', motionChanged);
    emit('dispose');
  }, { once: true });
})();
