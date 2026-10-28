// DeepSeek 助手：Relink 插件 API v4 示例（后台页面，没有窗口）。
// - /ai 问题        → 调用 DeepSeek，边生成边显示，回答以“来自 DeepSeek 助手”发进当前频道
// - /ai-summary     → 总结频道最近的聊天
// API Key 由用户在 设置 → 插件 中填写；插件读不到它，只在请求头里写 {{secret:deepseek}}，由 Relink 填入。
// 模型和自定义提示词也在 设置 → 插件 里选（manifest 的 settings）。
const relink = window.relinkPlugin;
const API = 'https://api.deepseek.com/chat/completions';
const MAX_MESSAGE = 3900; // 频道单条消息最多 4000 字
let busy = false;

/** 最近的频道消息，转成模型能读的对话记录（需要 Room 域主允许插件读取消息）。 */
async function recentChat(limit) {
  const chat = await relink.getChat();
  if (!chat.available) return { chat, lines: [] };
  // 跳过还在生成的消息（包括自己正在写的回答）。
  const lines = chat.messages.filter(m => m.text && !m.pending).slice(-limit).map(m => `${m.author.name}${m.plugin ? `（${m.plugin}）` : ''}：${m.text}`);
  return { chat, lines };
}

/** 读取 DeepSeek 的流式回答（server-sent events），每收到一段就交给 onText。 */
async function stream(messages, settings, onText) {
  let buffer = '', text = '', raw = '';
  const response = await relink.fetchStream(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{secret:deepseek}}' },
    body: JSON.stringify({ model: settings.model || 'deepseek-chat', messages, temperature: 0.7, max_tokens: 1200, stream: true }),
  }, chunk => {
    raw += chunk; buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      try { text += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || ''; onText(text); } catch { /* 不完整的一行，忽略 */ }
    }
  });
  if (response.status === 401) throw new Error('DeepSeek API Key 无效，请在 设置 → 插件 中重新填写。');
  if (response.status === 402) throw new Error('DeepSeek 账户余额不足。');
  if (response.status !== 200) { console.warn('DeepSeek 返回', response.status, raw.slice(0, 300)); throw new Error(`DeepSeek 暂时不可用（${response.status}）。`); }
  if (!text.trim()) throw new Error('DeepSeek 没有返回内容。');
  return text.trim();
}

/** 先发一条“正在生成”的消息，再随着回答更新它；出错时撤回这条消息。 */
async function answer(messages, settings) {
  const { id } = await relink.sendChat({ text: '', pending: true, format: 'markdown' });
  const cut = text => text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) + '…（回答过长，已截断）' : text;
  try {
    // editChat 可以随便多频繁地调用，Relink 会约每 0.8 秒合并发出一次。
    const text = await stream(messages, settings, partial => { relink.editChat({ id, text: cut(partial), pending: true }).catch(() => {}); });
    await relink.editChat({ id, text: cut(text) }); // 不带 pending：回答完成
  } catch (error) {
    await relink.deleteChat(id).catch(() => {});
    throw error;
  }
}

async function run(command) {
  if (busy) { await relink.notify({ title: '上一个问题还在回答中', body: '请稍候再试。' }); return; }
  const secrets = await relink.getSecretStatus();
  if (!secrets.deepseek) { await relink.notify({ title: '还没有填写 API Key', body: '请在 Relink 设置 → 插件 → DeepSeek 助手 中填写。' }); return; }
  busy = true;
  try {
    const settings = await relink.getSettings();
    const system = '你是 Relink 语音聊天软件频道里的助手，回答简洁友好，使用简体中文。可以使用 Markdown（加粗、列表、代码块），不要用表格。'
      + (settings.prompt?.trim() ? '\n' + settings.prompt.trim() : '');
    if (command.name === 'ai-summary') {
      const { chat, lines } = await recentChat(50);
      if (!chat.available) throw new Error(chat.reason || '暂时读不到频道消息。');
      if (!lines.length) throw new Error('频道里还没有可以总结的消息。');
      await answer([
        { role: 'system', content: system + '\n用 3 到 6 条要点总结下面的聊天，不要编造。' },
        { role: 'user', content: lines.join('\n') },
      ], settings);
      return;
    }
    const question = command.args.trim();
    if (!question) throw new Error('请在 /ai 后面写上问题，例如：/ai 今晚玩什么游戏');
    const { lines } = settings.useContext === false ? { lines: [] } : await recentChat(20);
    await answer([
      { role: 'system', content: system },
      ...(lines.length ? [{ role: 'system', content: '频道最近的聊天（供参考）：\n' + lines.join('\n') }] : []),
      { role: 'user', content: question },
    ], settings);
    // 记录用过多少次，演示 storage 权限。
    await relink.storage.set('questions', ((await relink.storage.get('questions')) || 0) + 1);
  } catch (error) {
    console.error(error);
    await relink.notify({ title: '没有完成', body: error.message || String(error) });
  } finally { busy = false; }
}

relink.onChatCommand(command => { void run(command); });
