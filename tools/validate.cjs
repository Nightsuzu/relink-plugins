'use strict';
// Checks a plugin folder before packing: node tools/validate.cjs <folder>
// Prints what is wrong in plain words, plus what the plugin will ask the user for.
const fs = require('node:fs');
const path = require('node:path');
const { inspectPackage, MAX_ASSET_BYTES, API_VERSIONS, PluginViolation, MANIFEST_ERRORS: MESSAGES, describeManifestError } = require('../runtime/package.cjs');

const LABELS = { 'voice.read': '读取通话状态', 'voice.mute': '控制麦克风静音', 'voice.deafen': '控制耳机拒听', 'app.show': '返回主窗口', 'window.resize': '调整插件浮窗', 'music.read': '读取支持的播放器曲目和封面', 'music.control': '控制播放器', 'music.lyrics': '匹配同步歌词', 'channels.read': '读取当前 Room 语音频道', 'channels.switch': '切换语音频道', 'voice.participants': '读取当前语音频道成员的昵称和说话状态',
  'net.fetch': '联网访问声明的网站', 'secrets': '保存用户填写的密钥（加密保存，插件读不到明文）', 'chat.read': '读取当前文字频道的消息（需 Room 域主允许）', 'chat.send': '以用户的名义在当前频道发消息（带插件标签）', 'chat.commands': '在聊天输入框注册命令', 'chat.history': '读取更早的消息和这个 Room 里你能看到的其他文字频道（需 Room 域主允许）', 'notify': '发送系统通知', 'storage': '在本机保存插件数据' };

function readFolder(source) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  const files = Object.create(null), skipped = [];
  let size = 0;
  for (const file of fs.readdirSync(source)) {
    if (file === 'manifest.json' || file.startsWith('.')) continue;
    const stat = fs.lstatSync(path.join(source, file));
    if (!stat.isFile() || stat.isSymbolicLink()) { skipped.push(file); continue; }
    size += stat.size;
    if (size > MAX_ASSET_BYTES) throw Object.assign(new Error('assets-size'), { code: 'assets-size' });
    files[file] = fs.readFileSync(path.join(source, file)).toString('base64');
  }
  return { manifest, files, skipped };
}

function validate(source) {
  let folder;
  try { folder = readFolder(source); }
  catch (error) { return { ok: false, problem: error.code ? describeManifestError(error.code) : error instanceof SyntaxError ? MESSAGES['package-json'] : `无法读取插件文件夹：${error.message}` }; }
  try {
    const { manifest } = inspectPackage(JSON.stringify({ format: 1, manifest: folder.manifest, files: folder.files }));
    const asks = [...manifest.capabilities.map(c => LABELS[c]),
      ...(manifest.commands ? [`在通话控制的插件菜单中添加 ${manifest.commands.length} 个按钮`] : []),
      ...(manifest.panel ? [`在语音页右侧添加「${manifest.panel.title}」面板`] : []),
      ...(manifest.background ? ['开启后在后台运行'] : []),
      ...(manifest.chatCommands ? [`聊天命令 ${manifest.chatCommands.map(c => '/' + c.name).join('、')}`] : []),
      ...(manifest.network ? [`会访问 ${manifest.network.join('、')}`] : []),
      ...(manifest.secrets ? [`需要用户填写 ${manifest.secrets.map(s => s.label).join('、')}`] : [])];
    const notes = [];
    if (!API_VERSIONS.includes(manifest.apiVersion)) notes.push(`当前 SDK 只认识 API ${API_VERSIONS.join('/')}，较新的 apiVersion 需要更新 Relink。`);
    if (manifest.capabilities.includes('chat.read') && manifest.capabilities.includes('net.fetch')) notes.push(`安装时会额外提醒用户：开启后，它可以把${manifest.capabilities.includes('chat.history') ? '这个 Room 里能看到的文字频道' : '所在频道'}的消息发送到 ${manifest.network.join('、')}。`);
    if (folder.skipped.length) notes.push(`已忽略子文件夹或链接：${folder.skipped.join('、')}`);
    return { ok: true, id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion, asks, notes };
  } catch (error) {
    if (error instanceof PluginViolation) return { ok: false, code: error.code, problem: describeManifestError(error.code, folder.manifest) };
    throw error;
  }
}

if (require.main === module) {
  const source = path.resolve(process.argv[2] || '.');
  const result = validate(source);
  if (!result.ok) { console.error(`✗ ${result.problem}${result.code ? `（${result.code}）` : ''}`); process.exitCode = 1; }
  else {
    console.log(`✓ ${result.id} v${result.version} · API ${result.apiVersion}`);
    console.log(`  安装时会向用户说明：${result.asks.join('、') || '不需要任何权限'}`);
    for (const note of result.notes) console.log(`  提示：${note}`);
  }
}
module.exports = { validate, MESSAGES };
