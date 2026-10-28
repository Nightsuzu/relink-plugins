'use strict';
// Creates a new plugin folder from a template:
//   node tools/create.cjs <folder> [--type panel|chat|ai] [--name 显示名称] [--id plugin-id]
// Without --type it asks. The generated manifest passes tools/validate.cjs as is.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { validate } = require('./validate.cjs');

const TYPES = {
  panel: '语音页面板：显示谁在说话（不联网）',
  chat: '聊天命令：/roll 掷骰子，结果发到频道（不联网）',
  ai: 'AI 助手：/ask 调用兼容 OpenAI 接口的 AI 服务，回答边生成边显示',
};

const html = (title, script, css) => `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${title}</title>${css ? '<link rel="stylesheet" href="style.css">' : ''}</head>
<body>${css ? '\n<main id="app">正在连接 Relink…</main>' : ''}
<script src="${script}"></script>
</body>
</html>
`;

function template(type, { id, name }) {
  if (type === 'panel') return {
    manifest: { id, name, version: '0.1.0', apiVersion: 4, description: '在语音页右侧显示当前频道里谁在说话。', capabilities: ['voice.read', 'voice.participants'], panel: { entry: 'panel.html', title: '谁在说话' } },
    files: {
      'panel.html': html(name, 'panel.js', true),
      'style.css': `body { margin: 0; font: 14px/1.6 system-ui, sans-serif; color: #1d2320; background: transparent; }
main { padding: 16px; }
ul { margin: 0; padding: 0; list-style: none; }
li { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
li::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #c7ccc9; }
li.speaking::before { background: #58b368; }
.muted { color: #8a918d; }
`,
      'panel.js': `// 语音页面板模板。界面只用 DOM 和 textContent，不要把成员昵称拼进 innerHTML。
// 调试：在 Relink 设置 → 插件 → 插件开发者模式 里打开「面板」的开发者工具，console.log 也会显示在插件日志里。
const relink = window.relinkPlugin;
const app = document.getElementById('app');

function render(state, people) {
  if (!state.inVoice) { app.textContent = '加入语音频道后显示成员。'; return; }
  const list = document.createElement('ul');
  for (const p of people) {
    const item = document.createElement('li');
    item.textContent = p.name + (p.self ? '（你）' : '') + (p.muted ? ' · 已静音' : '');
    if (p.speaking) item.className = 'speaking';
    if (p.muted) item.classList.add('muted');
    list.append(item);
  }
  app.replaceChildren(list);
}

let state = { inVoice: false }, people = [];
relink.onState(next => { state = next; render(state, people); });
relink.onParticipants(next => { people = next; render(state, people); });
Promise.all([relink.getState(), relink.getParticipants()]).then(([s, p]) => {
  state = s; people = p; render(state, people);
  console.log('面板已启动，当前成员', p.length, '人');
}).catch(error => { app.textContent = '读取失败：' + error.message; console.error(error); });
`,
    },
  };
  if (type === 'chat') return {
    manifest: { id, name, version: '0.1.0', apiVersion: 4, description: '在频道里输入 /roll 掷骰子，结果以插件消息发到频道。', background: 'background.html', capabilities: ['chat.send', 'chat.commands', 'notify', 'storage'], chatCommands: [{ name: 'roll', description: '掷骰子，例如 /roll 20' }] },
    files: {
      'background.html': html(name, 'background.js', false),
      'background.js': `// 聊天命令模板（后台页面，没有窗口）。
// 用户输入 /roll 时 Relink 把命令交给插件，命令本身不会发到频道。
// 调试：插件开发者模式里打开「后台」的开发者工具，或看设置页里的插件日志。
// 预览：node tools/preview.cjs <这个文件夹>，打开 /background，在模拟频道里输入 /roll 20。
const relink = window.relinkPlugin;

async function roll(args) {
  const sides = Number.parseInt(args, 10) || 6;
  if (sides < 2 || sides > 1000) throw new Error('面数需要在 2 到 1000 之间，例如 /roll 20');
  const value = 1 + Math.floor(Math.random() * sides);
  // 发出的消息会显示“来自 ${name}”。Relink 聊天显示纯文本，不渲染 Markdown。
  await relink.sendChat({ text: \`🎲 掷出 \${value}（1–\${sides}）\` });
  // storage 只保存在本机，卸载插件时删除。
  const count = ((await relink.storage.get('rolls')) || 0) + 1;
  await relink.storage.set('rolls', count);
  console.log('第', count, '次掷骰子：', value, '/', sides);
}

relink.onChatCommand(command => {
  if (command.name !== 'roll') return;
  roll(command.args).catch(error => {
    console.error(error);
    // 常见原因：Room 域主没有允许插件发消息、当前频道不能发言、发送太频繁。
    relink.notify({ title: '没有完成', body: error.message || String(error) }).catch(() => {});
  });
});
console.log('${name} 已启动，等待 /roll 命令');
`,
    },
  };
  return {
    manifest: { id, name, version: '0.1.0', apiVersion: 4, description: '在频道里输入 /ask 提问，AI 的回答边生成边显示，以插件消息发到频道。', background: 'background.html', capabilities: ['net.fetch', 'secrets', 'chat.read', 'chat.send', 'chat.commands', 'notify'], network: ['api.deepseek.com'], secrets: [{ id: 'api-key', label: 'AI 服务 API Key' }], chatCommands: [{ name: 'ask', description: '向 AI 提问，回答发到频道' }],
      settings: [
        { key: 'model', label: '模型', type: 'select', default: 'deepseek-chat', options: [{ value: 'deepseek-chat', label: '对话' }, { value: 'deepseek-reasoner', label: '推理' }] },
        { key: 'prompt', label: '自定义提示词（可选）', type: 'textarea', default: '', maxLength: 1000 },
      ] },
    files: {
      'background.html': html(name, 'background.js', false),
      'background.js': `// AI 助手模板（后台页面，没有窗口），适用于兼容 OpenAI Chat Completions 的服务。
// 换服务商：改下面的 API，并把 manifest.json 里 network 改成对应域名（只写域名，不带 https://），settings 里的模型选项也一起改。
// API Key 由用户在 Relink 设置 → 插件 里填写，插件读不到明文：请求头里写 {{secret:api-key}}，由 Relink 填入。
// 模型和自定义提示词是 manifest 里的 settings，用户在 设置 → 插件 里选。
// 预览：RELINK_SECRET_API_KEY=你的key node tools/preview.cjs <这个文件夹>，打开 /background，输入 /ask 你好。
// 读取频道消息需要 Room 域主在 Room 设置 → 插件 里允许；没有允许时 getChat() 的 available 为 false。
const relink = window.relinkPlugin;
const API = 'https://api.deepseek.com/chat/completions';
const MAX_MESSAGE = 3900; // 频道单条消息最多 4000 字
const SYSTEM = '你是 Relink 语音聊天软件频道里的助手，回答简洁友好，使用简体中文。可以使用 Markdown（加粗、列表、代码块），不要用表格。';
let busy = false;

async function context() {
  const chat = await relink.getChat();
  if (!chat.available) return [];
  return chat.messages.filter(m => m.text && !m.pending).slice(-20).map(m => \`\${m.author.name}：\${m.text}\`);
}

/** 流式请求：每收到一段回答就调用 onText（server-sent events，每行 "data: {...}"）。 */
async function stream(question, settings, onText) {
  const lines = await context();
  let buffer = '', text = '';
  const response = await relink.fetchStream(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{secret:api-key}}' },
    body: JSON.stringify({ model: settings.model, max_tokens: 1200, stream: true, messages: [
      { role: 'system', content: SYSTEM + (settings.prompt?.trim() ? '\\n' + settings.prompt.trim() : '') },
      ...(lines.length ? [{ role: 'system', content: '频道最近的聊天（供参考）：\\n' + lines.join('\\n') }] : []),
      { role: 'user', content: question },
    ] }),
  }, chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      try { text += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || ''; onText(text); } catch { /* 不完整的一行 */ }
    }
  });
  console.log('AI 服务返回', response.status);
  if (response.status === 401) throw new Error('API Key 无效，请在 设置 → 插件 中重新填写。');
  if (response.status !== 200) throw new Error(\`AI 服务暂时不可用（\${response.status}）。\`);
  if (!text.trim()) throw new Error('AI 服务没有返回内容。');
  return text.trim();
}

relink.onChatCommand(async command => {
  if (command.name !== 'ask') return;
  if (busy) { relink.notify({ title: '上一个问题还在回答中' }).catch(() => {}); return; }
  busy = true;
  let id;
  try {
    if (!(await relink.getSecretStatus())['api-key']) throw new Error('还没有填写 API Key：设置 → 插件 → ${name}。');
    const question = command.args.trim();
    if (!question) throw new Error('请在 /ask 后面写上问题。');
    const settings = await relink.getSettings();
    // 先发一条“正在生成…”的消息，再随着回答更新它。editChat 可以很频繁地调用，Relink 会合并。
    ({ id } = await relink.sendChat({ text: '', pending: true, format: 'markdown' }));
    const cut = text => text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) + '…（已截断）' : text;
    const text = await stream(question, settings, partial => { relink.editChat({ id, text: cut(partial), pending: true }).catch(() => {}); });
    await relink.editChat({ id, text: cut(text) }); // 不带 pending：完成
  } catch (error) {
    console.error(error);
    if (id) relink.deleteChat(id).catch(() => {});
    relink.notify({ title: '没有完成', body: error.message || String(error) }).catch(() => {});
  } finally { busy = false; }
});
console.log('${name} 已启动，等待 /ask 命令');
`,
    },
  };
}

function option(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }

async function main(args) {
  const folderArg = args.find((a, i) => !a.startsWith('--') && !['--type', '--name', '--id'].includes(args[i - 1]));
  if (!folderArg) { console.error('用法：node tools/create.cjs <新插件文件夹> [--type panel|chat|ai] [--name 显示名称] [--id plugin-id]'); process.exitCode = 1; return; }
  const folder = path.resolve(folderArg);
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) { console.error(`✗ ${folder} 已存在且不是空文件夹，换一个位置，避免覆盖已有文件。`); process.exitCode = 1; return; }
  let type = option(args, '--type');
  if (!type && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('选择模板：'); Object.entries(TYPES).forEach(([key, label], i) => console.log(`  ${i + 1}. ${key} — ${label}`));
    const answer = (await rl.question('输入编号或名称（默认 1）：')).trim();
    rl.close();
    type = Object.keys(TYPES)[Number(answer) - 1] || answer || 'panel';
  }
  type ||= 'panel';
  if (!TYPES[type]) { console.error(`✗ 没有 ${type} 模板。可选：${Object.keys(TYPES).join('、')}`); process.exitCode = 1; return; }
  const id = option(args, '--id') || path.basename(folder).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '');
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) { console.error('✗ 无法从文件夹名得到插件 ID，请用 --id 指定（小写字母开头，只含小写字母、数字和连字符，3–64 个字符）。'); process.exitCode = 1; return; }
  // The name goes into HTML and JS string literals of the template, so keep it to plain text.
  const name = (option(args, '--name') || id).replace(/[ -'"`\<>&$]/g, '').trim().slice(0, 80) || id;
  const { manifest, files } = template(type, { id, name });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), content);
  const result = validate(folder);
  if (!result.ok) { console.error(`✗ 模板没有通过检查：${result.problem}`); process.exitCode = 1; return; }
  const rel = path.relative(process.cwd(), folder) || '.';
  console.log(`✓ 已创建 ${name}（${id}）：${folder}`);
  console.log(`  模板：${TYPES[type]}`);
  console.log('下一步：');
  console.log(`  1. 预览：node ${path.relative(process.cwd(), path.join(__dirname, 'preview.cjs'))} ${rel}${type === 'ai' ? '（先设置环境变量 RELINK_SECRET_API_KEY）' : ''}`);
  console.log('  2. 在 Relink 设置 → 插件 → 插件开发者模式 中选择这个文件夹，保存文件后自动重新加载');
  console.log('  3. 出错时看设置页里的插件日志，或打开开发者工具；说明见 docs/debugging.md');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { template, TYPES };
