'use strict';
/*
 * Relink 浮岛 · 音乐视图
 *
 * 读取宿主的媒体快照，渲染展开面板里的“音乐”视图，并把标题栏需要的摘要
 * 通过 Float.setMusic() 交给外壳。这个文件不直接写标题栏。
 *
 * 轮询节奏（旧版收起时每秒约 1 次、展开时每秒 4 次，外加常驻 250 ms 定时器）：
 *   展开且在音乐视图 500 ms；展开看别的视图 1.5 s；收起播放中 1 s；
 *   收起已暂停 2 s；没有音乐 3 s；游戏刘海状态以上各项加倍；接口连续报错 5 s。
 * 进度和歌词在两次采样之间用本地时间外推，定时器只在“下一句歌词”或
 * “下一秒”到来时触发，暂停时不运行。
 */
(() => {
  const { bridge, $, on, notice, setMusic, reduceMotion } = window.Float;
  if (typeof bridge.getMedia !== 'function') { $('music-empty-title').textContent = '当前版本不支持音乐接口'; return; }

  const PLAYERS = { qqmusic: 'QQ 音乐', netease: '网易云音乐', soda: '汽水音乐' };
  const LYRIC_STATUS = {
    instrumental: '纯音乐 · 静静聆听', loading: '正在匹配歌词', synced: '前奏', disabled: '歌词权限未开启',
    waiting: '等待完整歌曲信息', retrying: '歌词连接暂不可用，稍后重试',
  };
  let snapshot = { sessions: [] }, track = null, failures = 0, closed = false;
  let polling = null, pollTimer = 0, tickTimer = 0, pendingControls = 0;
  let trackKey = '', lyricKey = '', coverSrc = '';

  const clock = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
  function pulse(element) {
    if (reduceMotion() || Float.mode !== 'expanded') return;
    for (const animation of element.getAnimations()) animation.cancel();
    element.animate([{ opacity: .5 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  }

  // 宿主采样进度 + 最多 2.5 秒的本地外推（见 docs/media-and-channels.md）。
  function position() {
    const elapsed = track.playing && track.durationMs > 0 ? Math.min(2500, Math.max(0, Date.now() - snapshot.updatedAt)) : 0;
    return Math.min(track.durationMs || 86400000, track.positionMs + elapsed);
  }

  // 随时间变化的部分：进度、时间、歌词，以及交给标题栏的摘要。
  function paint() {
    clearTimeout(tickTimer);
    if (!track) { setMusic(null); return; }
    const now = position(), lines = track.lyrics?.lines || [];
    let index = -1; while (index + 1 < lines.length && lines[index + 1].time <= now) index++;
    const current = index >= 0 ? lines[index].text : LYRIC_STATUS[track.lyrics?.status] || '暂无匹配的同步歌词';
    const upcoming = lines[index + 1]?.text || '';
    const progress = track.durationMs ? now / track.durationMs : 0;

    setText($('elapsed'), track.durationMs ? clock(now) : '--:--');
    setText($('duration'), track.durationMs ? clock(track.durationMs) : '进度未提供');
    $('progress').value = progress;
    const key = current + '\n' + upcoming;
    if (key !== lyricKey) { lyricKey = key; setText($('lyric-now'), current); setText($('lyric-next'), upcoming); pulse($('lyric')); }

    setMusic({
      source: track.source, player: PLAYERS[track.source] || '音乐', title: track.title, cover: track.cover || '',
      playing: track.playing, progress,
      // 收起时第二行：有歌词显示当前这句，否则显示歌手。
      line: index >= 0 ? lines[index].text : track.artist || '未知艺术家',
    });

    // 只在看得见变化的时候才定时：刘海状态不显示进度和歌词。
    if (!track.playing || !track.durationMs || Float.mode === 'notch') return;
    const untilLyric = lines[index + 1] ? lines[index + 1].time - now : Infinity;
    const untilSecond = 1000 - now % 1000;
    tickTimer = setTimeout(paint, Math.max(60, Math.min(untilLyric, untilSecond) + 15));
  }

  // 采样变化时才需要重画的部分：曲目、封面、按钮可用性。
  function render() {
    const source = snapshot.activeSource || track?.source || snapshot.sessions[0]?.source;
    const sessions = snapshot.sessions.filter(session => session.source === source);
    track = sessions.find(session => session.current) || sessions[0] || null;
    $('music-content').hidden = !track; $('music-empty').hidden = Boolean(track);
    if (!track) {
      trackKey = '';
      setText($('music-empty-title'), snapshot.available === false ? '音乐连接暂不可用' : snapshot.activeSource ? '等待 ' + (PLAYERS[snapshot.activeSource] || '播放器') + ' 的媒体信息' : '让音乐靠近一点');
      paint(); return;
    }
    const identity = track.id + '\n' + track.track;
    if (identity !== trackKey) {
      trackKey = identity; lyricKey = '';
      setText($('track-title'), track.title); setText($('track-artist'), track.artist || '未知艺术家');
      pulse($('track-title').parentElement);
    }
    const cover = track.cover || '';
    if (cover !== coverSrc) {
      coverSrc = cover;
      if (cover) $('cover').src = cover; else { $('cover').hidden = true; $('no-cover').hidden = false; $('cover').removeAttribute('src'); }
    }
    for (const name of ['previous', 'next']) {
      $(name).disabled = !track.controls[name];
      $(name).title = track.controls[name] ? '' : (PLAYERS[track.source] || '播放器') + '未开放此控制';
    }
    const toggle = track.playing ? 'pause' : 'play';
    $('play-pause').disabled = !track.controls[toggle];
    $('play-pause').setAttribute('aria-label', track.playing ? '暂停' : '播放');
    $('play-path').setAttribute('d', track.playing ? 'M9 5v14M16 5v14' : 'm9 5 11 7-11 7Z');
    paint();
  }
  // 封面解码完成后再显示，避免先出现空白方块。
  $('cover').addEventListener('load', () => { $('cover').hidden = false; $('no-cover').hidden = true; });
  $('cover').addEventListener('error', () => { $('cover').hidden = true; $('no-cover').hidden = false; });

  function poll() {
    if (closed) return Promise.resolve();
    if (!polling) polling = (async () => {
      try { snapshot = await bridge.getMedia(); failures = 0; }
      // 偶发失败（例如触发宿主限流）保留上一次的画面，连续 3 次才认为音乐不可用。
      catch { if (++failures >= 3) snapshot = { sessions: [], available: false }; }
      finally { polling = null; }
      if (!closed) render();
    })();
    return polling;
  }
  function pollDelay() {
    if (failures) return failures >= 3 ? 5000 : 1500;
    if (Float.mode === 'expanded') return Float.view === 'music' ? 500 : 1500;
    const base = track?.playing ? 1000 : track ? 2000 : 3000;
    return Float.mode === 'notch' ? base * 2 : base;
  }
  async function cycle() {
    clearTimeout(pollTimer);
    await poll();
    if (!closed) { clearTimeout(pollTimer); pollTimer = setTimeout(cycle, pollDelay()); }
  }

  async function control(action) {
    if (!track || pendingControls >= 3) return;       // 宿主最多串行排队 3 个控制请求
    pendingControls++; notice('');
    $('play-pause').setAttribute('aria-busy', 'true');
    try {
      await bridge.controlMedia({ session: track.id, action });
      // 发送成功不等于播放器已经执行：马上重取，再补两次。
      await poll(); setTimeout(() => void poll(), 150); setTimeout(() => void poll(), 400);
    } catch { notice('播放器暂未执行操作，请再试一次'); }
    finally { pendingControls--; $('play-pause').setAttribute('aria-busy', String(pendingControls > 0)); }
  }
  $('play-pause').addEventListener('click', () => void control(track?.playing ? 'pause' : 'play'));
  for (const name of ['previous', 'next']) $(name).addEventListener('click', () => void control(name));

  // 展开、离开刘海或切到音乐视图时立刻取一次，其余时候等下一轮。
  let lastMode = Float.mode;
  on('mode', mode => { const wake = mode === 'expanded' || lastMode === 'notch'; lastMode = mode; if (wake) void cycle(); else paint(); });
  on('view', view => { if (view === 'music') void cycle(); });
  on('dispose', () => { closed = true; clearTimeout(pollTimer); clearTimeout(tickTimer); });
  void cycle();
})();
