'use strict';
const { PluginViolation } = require('../runtime/package.cjs');
const ACTION_CAPABILITY = { mute: 'voice.mute', deafen: 'voice.deafen', show: 'app.show', expand: 'window.resize', collapse: 'window.resize' };
function sanitizeState(value = {}) {
  return {
    authenticated: value.authenticated === true,
    connected: value.connected === true,
    inVoice: value.inVoice === true,
    roomName: typeof value.roomName === 'string' ? value.roomName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '',
    memberCount: Number.isSafeInteger(value.memberCount) ? Math.max(0, Math.min(100000, value.memberCount)) : 0,
    muted: value.muted === true, deafened: value.deafened === true,
    sharing: value.sharing === true,
  };
}
function allowedAsset(url, id, assets) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'relink-plugin:' || u.hostname !== id || u.search || u.hash || u.username || u.password || u.port) return null;
    const name = u.pathname.slice(1);
    return assets.has(name) ? name : null;
  } catch { return null; }
}
function actionPolicy(value, capabilities, state) {
  if (typeof value !== 'string' || !Object.hasOwn(ACTION_CAPABILITY, value) || !capabilities.includes(ACTION_CAPABILITY[value])) throw new PluginViolation('capability');
  if (!state.authenticated || (['mute', 'deafen'].includes(value) && (!state.inVoice || !state.connected))) return false;
  return true;
}
function limiter(limit = 8, clock = Date.now) {
  let start = clock(), count = 0;
  return () => { const now = clock(); if (now - start >= 1000) { start = now; count = 0; } return ++count <= limit; };
}
const CAPABILITY_LABELS = { 'voice.read':'读取通话状态','voice.mute':'控制麦克风静音','voice.deafen':'控制耳机拒听','app.show':'返回主窗口','window.resize':'调整插件浮窗','music.read':'读取支持的播放器曲目和封面','music.control':'控制播放器','music.lyrics':'匹配同步歌词（QQ 音乐、网易云、LRCLIB）','channels.read':'读取当前 Room 语音频道','channels.switch':'切换语音频道','voice.participants':'读取当前语音频道成员的昵称和说话状态',
  'net.fetch':'联网访问声明的网站','secrets':'保存你填写的密钥（加密保存，插件读不到明文）','chat.read':'读取当前文字频道的消息（需 Room 域主允许）','chat.send':'以你的名义在当前频道发消息（带插件标签）','chat.commands':'在聊天输入框注册命令','chat.history':'读取更早的消息和这个 Room 里你能看到的其他文字频道（需 Room 域主允许）','notify':'发送系统通知','storage':'在本机保存插件数据' };
/** The install / update prompt: every capability, every host it reaches, and data-leaving combinations spelled out. */
function permissionSummary(manifest, { capabilities, hosts } = {}) {
  const caps = capabilities || manifest.capabilities, reach = hosts || manifest.network || [];
  const extras = capabilities ? [] : [manifest.commands?.length ? `在通话控制的插件菜单中添加 ${manifest.commands.length} 个按钮` : '', manifest.panel ? `在语音页右侧添加「${manifest.panel.title}」面板` : '', manifest.background ? '开启后在后台运行' : '', manifest.chatCommands?.length ? `聊天命令 ${manifest.chatCommands.map(c => '/' + c.name).join('、')}` : ''].filter(Boolean);
  const lines = [];
  if (caps.length || extras.length || !capabilities) lines.push(`允许的功能：${[...caps.map(c => CAPABILITY_LABELS[c] || c), ...extras].join('、') || '无'}`);
  if (reach.length) lines.push(`会访问：${reach.join('、')}`);
  if (manifest.secrets?.length && caps.includes('secrets')) lines.push(`需要你填写：${manifest.secrets.map(s => s.label).join('、')}`);
  if (manifest.capabilities.includes('chat.read') && manifest.capabilities.includes('net.fetch') && (caps.includes('chat.read') || caps.includes('net.fetch') || reach.length)) lines.push(`注意：开启后，它可以把${manifest.capabilities.includes('chat.history') ? '这个 Room 里你能看到的文字频道' : '所在频道'}的消息发送到 ${(manifest.network || []).join('、')}。`);
  return lines.join('\n');
}
module.exports = { sanitizeState, allowedAsset, actionPolicy, limiter, CAPABILITY_LABELS, permissionSummary };
