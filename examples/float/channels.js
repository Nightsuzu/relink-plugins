'use strict';
/*
 * Relink 浮岛 · 频道视图
 *
 * 只在“频道”视图可见时读取频道列表：打开视图、通话状态变化、切换完成后各取
 * 一次，另外每 4 秒刷新一次（旧版在视图打开期间每秒读取约 4 次）。
 */
(() => {
  const { bridge, $, on, notice } = window.Float;
  if (typeof bridge.getChannels !== 'function') { document.querySelector('[data-view=channels]').hidden = true; return; }

  const REFRESH = 4000;
  let state = { scope: '', channels: [] }, rendered = '', busy = false, loading = false, closed = false, timer = 0;
  const visible = () => !closed && Float.mode === 'expanded' && Float.view === 'channels';

  function render() {
    const key = JSON.stringify(state);
    if (key === rendered) return;
    rendered = key;
    $('channel-empty').hidden = state.channels.length > 0;
    $('channels').replaceChildren(...state.channels.map(channel => {
      const button = document.createElement('button'), label = document.createElement('span'), tag = document.createElement('small');
      label.textContent = channel.name;
      tag.textContent = channel.current ? '通话中' : channel.locked ? '需密码' : '加入';
      button.append(label, tag);
      button.disabled = channel.locked || channel.current;
      button.setAttribute('aria-current', String(channel.current));
      button.addEventListener('click', () => void switchTo(channel));
      return button;
    }));
  }
  async function refresh() {
    clearTimeout(timer);
    if (!visible() || busy || loading) return;
    loading = true;
    try { state = await bridge.getChannels(); if (!busy) render(); }
    catch { notice('频道列表暂不可用'); }
    finally { loading = false; }
    if (visible()) { clearTimeout(timer); timer = setTimeout(refresh, REFRESH); }
  }
  async function switchTo(channel) {
    if (busy) return;
    busy = true; notice('正在连接 ' + channel.name);
    for (const button of $('channels').children) button.disabled = true;
    // 必须传回原快照的 scope；主客户端确认真实通话状态后才算成功。
    try { await bridge.switchChannel({ scope: state.scope, id: channel.id }); notice('已进入 ' + channel.name); }
    catch { notice('尚未切换，请返回 Relink 查看'); }
    finally { busy = false; rendered = ''; void refresh(); }
  }

  on('view', () => void refresh());
  on('mode', () => void refresh());
  on('voice', () => void refresh());
  on('dispose', () => { closed = true; clearTimeout(timer); });
})();
