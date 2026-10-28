# 插件 API v4

API v4 让插件可以联网、接入 AI 服务、读写频道聊天。新增八项权限和一个后台页面：

| 权限 | 作用 |
| --- | --- |
| `net.fetch` | 通过 Relink 访问 manifest 里声明的网站（HTTPS） |
| `secrets` | 让用户填写 API Key 等密钥，由 Relink 加密保存 |
| `chat.read` | 读取当前打开的文字频道最近 50 条消息 |
| `chat.send` | 以用户的名义在当前频道发消息，消息带“来自 插件名”标签 |
| `chat.commands` | 在聊天输入框注册 `/命令` |
| `chat.history` | 读取更早的消息和这个 Room 里能看到的其他文字频道（需同时有 `chat.read`） |
| `notify` | 发送系统通知 |
| `storage` | 在本机保存插件自己的数据（5 MB） |

v1–v3 插件不用改动。完整示例见 `examples/deepseek-assistant/`：在频道里输入 `/ai 问题`，调用 DeepSeek，把回答发进频道。

## 开放原则

v4 不再一刀切地“不联网、不给内容”，而是**给，但让用户看得见、管得住**：

- **按权限声明。** 每项能力对应 manifest 里的一个权限；联网的网站、要填的密钥、聊天命令也都写在 manifest 里，安装时逐条告诉用户。新版本增加权限或网站时，用户需要再次确认。
- **危险组合单独提醒。** 同时申请 `chat.read` 和 `net.fetch` 的插件，安装时会写明“开启后，它可以把所在频道的消息发送到 api.deepseek.com”。
- **联网由 Relink 代发。** 插件页面本身仍然是 `connect-src 'none'`，只能调用 `relinkPlugin.fetch()`。Relink 只放行声明过的网站，拒绝 IP、localhost 和内网地址（按解析后的地址检查），不带 Relink 的登录状态和 Cookie。
- **密钥插件读不到。** 插件只能在请求头里写 `{{secret:id}}`，由 Relink 在发出请求时填入；插件只能知道“填了没有”。
- **别人的消息由 Room 域主决定。** 读取频道消息需要 Room 域主在 Room 设置 → 插件 中打开“允许插件读取消息”（默认关闭）。打开后，频道里所有人都能看到提示。
- **插件发的消息必须标明来源。** 走和用户手动发送相同的流程，职位权限、频道密码、限速都照旧，消息显示“来自 插件名”。Room 域主可以关闭“允许插件发消息”（默认开启）。
- **身份仍是匿名的。** 消息、作者、频道的 id 都是按插件区分的匿名标识，读不到账号 ID、手机号或令牌。
- **随时撤销。** 用户可以关闭或卸载插件；卸载时一并删除它的密钥、数据和网络记录。设置 → 插件 → 网络记录 可以看到它最近访问了哪些网站。

## manifest.json

```json
{
  "id": "deepseek-assistant",
  "name": "DeepSeek 助手",
  "version": "0.1.0",
  "apiVersion": 4,
  "description": "在频道里输入 /ai 提问。",
  "background": "background.html",
  "capabilities": ["net.fetch", "secrets", "chat.read", "chat.send", "chat.commands", "notify", "storage"],
  "network": ["api.deepseek.com"],
  "secrets": [{ "id": "deepseek", "label": "DeepSeek API Key" }],
  "chatCommands": [{ "name": "ai", "description": "向 DeepSeek 提问" }]
}
```

| 字段 | 说明 |
| --- | --- |
| `apiVersion` | 使用任何 v4 功能时必须写 `4`。 |
| `background` | 后台页面：没有窗口，插件开启并登录后一直运行。只有后台页面的插件可以省略 `entry`。 |
| `network` | 和 `net.fetch` 一起声明：1–8 个小写公网域名，精确匹配（`api.deepseek.com` 不包含其他子域名）。 |
| `secrets` | 和 `secrets` 权限一起声明，并需要 `net.fetch`：最多 4 项 `{ id, label }`。 |
| `chatCommands` | 和 `chat.commands` 一起声明：最多 8 个 `{ name, description }`，`name` 是小写字母、数字和 `-`。 |

打包前先运行 `node tools/validate.cjs <插件文件夹>`，它会用中文指出问题，并列出安装时会向用户说明的内容。

## 联网：`fetch` 和 `fetchStream`（`net.fetch`）

```js
const response = await relinkPlugin.fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{secret:deepseek}}' },
  body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] }),
});
// { status: 200, headers: {...}, body: '{"choices":[...]}' }
```

流式返回（例如 AI 逐字输出）：

```js
await relinkPlugin.fetchStream(url, { method: 'POST', headers, body, id: 'answer-1' }, text => append(text));
// 需要中途停止时：relinkPlugin.abortFetch('answer-1')
```

限制：只允许 HTTPS 默认端口；方法 GET/POST/PUT/PATCH/DELETE；请求内容是文本，最大 1 MB；响应最大 8 MB；单次最长 120 秒；每分钟 60 次，同时最多 4 个。不会自动跟随重定向（3xx 原样返回）。`Cookie`、`Host`、`Origin` 等请求头会被忽略，响应里的 `Set-Cookie` 不会交给插件。

## 密钥（`secrets`）

用户在 设置 → 插件 里填写，Relink 用系统加密（Windows 数据保护）保存在本机。

```js
const status = await relinkPlugin.getSecretStatus(); // { deepseek: true }
```

插件读不到明文。要用它时，在 `fetch` 的请求头里写 `{{secret:deepseek}}`；只能用于本插件声明的密钥，只能出现在请求头里。没填写时请求会失败，并提示用户去哪里填写。

## 频道聊天（`chat.read`、`chat.send`）

```js
const chat = await relinkPlugin.getChat();
// {
//   available: true, canSend: true,
//   channel: { id: 'c…', name: '日常闲聊' },
//   messages: [{ id: 'm…', author: { id: 'u…', name: '小雨', self: false }, text: '晚上开黑吗', at: '2026-10-27T12:00:00.000Z', replyTo?: 'm…', plugin?: 'DeepSeek 助手' }]
// }
const stop = relinkPlugin.onChat(next => render(next));
await relinkPlugin.sendChat({ text: '好的，我来查一下。', replyTo: chat.messages.at(-1).id });
```

- 只包含用户当前打开的文字频道，最近 50 条；切换频道或 Room 后推送新内容。
- 没有 `chat.read`，或 Room 域主没有允许时，`available` 为 `false`，`messages` 为空，`reason` 说明原因。只有 `chat.send` 的插件仍能拿到频道名称和 `canSend`。
- `plugin` 表示这条消息是哪个插件代发的，可用来避免插件互相回复。
- 每条消息还有 `likes`（点赞数）、`pinned`、`edited`、`pending`（还在生成）、`format`，以及 `mine`（这个插件自己发的）。
- `sendChat` 每分钟最多 20 条，单条 1–4000 字；`replyTo` 需要同时有 `chat.read`。服务器保存后才返回 `{ id }`；失败时抛出原因（例如 Room 不允许插件发消息、当前职位只能阅读）。

### 消息事件

```js
relinkPlugin.onChatEvent(event => {
  if (event.type === 'message' && !event.message.plugin) reply(event.message); // 新消息；跳过插件发的，避免互相回复
  if (event.type === 'channel') reset(event.channel);                          // 用户切换了频道或 Room
});
```

| type | 什么时候 | 内容 |
| --- | --- | --- |
| `message` | 有新消息 | `message` |
| `edit` | 插件改了自己的消息（含流式更新） | `message` |
| `like` / `pin` | 点赞数变化 / 置顶变化 | `message` |
| `withdraw` | 消息被撤回 | `id` |
| `channel` | 切换了频道或 Room（离开时为 `null`） | `channel` |

除 `channel` 外，事件只在插件能读取消息时推送。`onChat` 照旧推送整个快照。

### 修改、撤回和流式回答

```js
const { id } = await relinkPlugin.sendChat({ text: '', pending: true, format: 'markdown' }); // 先显示“正在生成…”
let answer = '';
await relinkPlugin.fetchStream(API, request, chunk => {
  answer += parse(chunk);
  relinkPlugin.editChat({ id, text: answer, pending: true });  // 随便多频繁都行，Relink 约每 0.8 秒合并发出一次
});
await relinkPlugin.editChat({ id, text: answer });              // 最后一次不带 pending，表示完成
```

- 只能修改、撤回**这个插件自己发的**消息，发出后 15 分钟内有效；用户自己的消息不能被插件改。Relink 重启后，之前发的消息不能再改。
- 生成过程中频道里显示“正在生成…”，不显示“已编辑”；完成之后再改，消息会标“已编辑”。插件中途停止时，“正在生成”最多显示 15 分钟。
- `deleteChat(id)` 撤回自己发的消息。
- 旧版客户端看到的是文字逐步变长。

### Markdown

`sendChat({ text, format: 'markdown' })` 的消息会在频道里渲染。支持：**加粗**、*斜体*、~~删除线~~、`行内代码`、代码块（带复制按钮）、有序 / 无序列表、引用、分隔线；标题显示为加粗的一行；链接 `[文字](https://…)` 会同时显示文字和网址，点击时走 Relink 的外链确认。不支持图片、HTML 和表格（原样显示为文字）。

没有 `format` 的消息、以及用户自己发的消息，都按纯文本显示。插件读取消息时拿到的是原始文字。

### 更早的消息和其他频道（`chat.history`）

```js
const channels = await relinkPlugin.getChatChannels();      // [{ id, name, current }]
let page = await relinkPlugin.getChatHistory({ channelId: channels[0].id, limit: 50 });
while (page.hasMore) page = await relinkPlugin.getChatHistory({ channelId: page.channel.id, before: page.messages[0].at });
```

- 需要同时声明 `chat.read`，并且 Room 域主允许插件读取消息。安装时会单独说明“可以读取这个 Room 里你能看到的所有文字频道”。
- 只包含你现在能打开的频道（设了密码且没解锁的不在内），范围是 Relink 已加载的消息，每个 Room 最多 500 条。
- 每分钟最多 60 次。发消息仍然只能发到当前打开的频道。

### 语音进出事件（`voice.participants`）

```js
relinkPlugin.onVoiceEvent(({ type, member }) => { if (type === 'join' && !member.self) greet(member.name); });
```

有人加入或离开当前语音频道时推送。你自己进出通话只推送一条关于你的事件，不会逐个推送频道里的其他人。

## 聊天命令（`chat.commands`）

```js
relinkPlugin.onChatCommand(({ name, args, channel }) => {
  if (name === 'ai') answer(args);
});
```

用户在输入框打 `/` 时，Relink 会列出已开启插件的命令。输入 `/ai 今晚玩什么` 并发送后，这段文字**不会**发到频道，只交给对应插件。插件需要正在运行（有后台页面、浮窗或面板）；同名命令按插件列表顺序交给第一个。

## 通知（`notify`）与存储（`storage`）

```js
await relinkPlugin.notify({ title: '回答好了', body: '已发送到 #日常闲聊' }); // 每分钟最多 6 条
await relinkPlugin.storage.set('history', [...]);   // 可转成 JSON 的值，单项 ≤ 1 MB，总共 ≤ 5 MB
const history = await relinkPlugin.storage.get('history');
await relinkPlugin.storage.remove('history');
const keys = await relinkPlugin.storage.keys();
```

存储只在这台电脑上，卸载插件时删除。

## 后台页面

`background` 页面没有窗口，插件开启并登录后一直运行，适合做 AI 助手、提醒这类“不需要界面”的插件。它和浮窗、面板共用同一个隔离环境和同样的权限，也计入“最多同时运行 3 个插件”。`getHostInfo().surface` 在后台页面里是 `'background'`。

## 设置项

v4 新增文字（`text`）、多行文字（`textarea`）和下拉选择（`select`）三种设置，见 [settings.md](settings.md)。设置值插件能读到明文，**不要用来存 API Key**，密钥请用 `secrets`。

## 宿主信息

`getHostInfo()` 在 v4 客户端上多了 `background`、`network`、`secrets`、`chatCommands` 字段，`supportedApiVersions` 包含 `4`。旧客户端没有这些方法，调用前请先检查是否存在。
