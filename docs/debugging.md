# 开发与调试指南

从零写一个插件，到在 Relink 里跑起来、出错时找到原因。需要 Node.js 22 或更新版本，SDK 没有第三方依赖。

## 1. 从模板开始

```sh
node tools/create.cjs ../my-plugin
```

会让你选一个模板（也可以加 `--type panel|chat|ai`，`--name 显示名称`，`--id plugin-id`）：

| 模板 | 做什么 | 用到的权限 |
| --- | --- | --- |
| `panel` | 语音页右侧面板，显示谁在说话 | `voice.read`、`voice.participants` |
| `chat` | 后台运行，频道里输入 `/roll 20` 掷骰子，结果发到频道 | `chat.send`、`chat.commands`、`notify`、`storage` |
| `ai` | 后台运行，`/ask 问题` 调用兼容 OpenAI 接口的 AI 服务，回答发到频道 | `net.fetch`、`secrets`、`chat.read`、`chat.send`、`chat.commands`、`notify` |

生成的文件夹直接能通过检查，可以马上预览或加载。

## 2. 在浏览器里预览

```sh
node tools/preview.cjs ../my-plugin
```

终端会列出可以打开的地址：

- `/`：桌面浮层（`entry`）
- `/panel`：语音页面板（`panel.entry`）
- `/background`：后台页面（`background`），旁边带一个**模拟频道**

模拟频道里：

- 输入 `/命令 参数` 会交给插件的 `onChatCommand`，和 Relink 一样不会发到频道；
- 输入普通文字，相当于你自己发了一条消息，插件的 `onChat` 会收到；
- 「让别人说一句」模拟其他成员发言；
- 两个勾选框模拟 Room 域主是否允许插件读取 / 发送消息，用来测试被拒绝时插件的表现；
- 插件用 `sendChat` 发出的消息会带「来自 插件名」标签，`editChat` / `deleteChat` 和「正在生成…」「已编辑」状态都能看到（预览里修改立即生效，客户端里约每 0.8 秒合并一次；Markdown 消息在预览里显示原文）；
- `onChatEvent` 会收到新消息、修改、撤回事件；声明了 `chat.history` 时可以读到另一个模拟频道「攻略」（80 条，可分页）；
- 声明了 `voice.participants` 时，「模拟有人进出语音」按钮会触发 `onVoiceEvent`；
- `notify` 显示在页面左上角；`storage` 只保存在这个页面里，刷新后清空；
- manifest 里的 `settings` 会显示在下方，可以直接改。

**联网是真实的。** `relinkPlugin.fetch` 由预览服务器代发，检查规则和 Relink 相同：只能访问 `network` 里声明的 HTTPS 域名，不能访问本机和内网地址，`{{secret:id}}` 只能写在请求头里。密钥从环境变量读取，变量名是 `RELINK_SECRET_` 加上大写的密钥 id（连字符换成下划线）：

```sh
# macOS / Linux
RELINK_SECRET_API_KEY=sk-xxx node tools/preview.cjs ../my-plugin
# Windows PowerShell
$env:RELINK_SECRET_API_KEY="sk-xxx"; node tools/preview.cjs ../my-plugin
```

和 Relink 一样，插件页面自己调用 `fetch`、`XMLHttpRequest`、`WebSocket` 会直接报错，只能用 `relinkPlugin.fetch`。

浏览器的开发者工具（F12）可以看 console、断点调试。预览用的是模拟数据，最后仍要在 Relink 里试一遍。

## 3. 在 Relink 里加载（插件开发者模式）

1. 打开 Relink **设置 → 插件**，拉到最下面，打开「插件开发者模式」并确认。
2. 点「选择插件文件夹」，选你的插件文件夹。插件会带「开发中」标记，默认开启。
3. 保存文件后自动重新加载，不需要重启 Relink。

开发者模式只在本次运行有效，重启 Relink 后自动关闭。插件和正式插件在同样的隔离环境里运行，只能使用 manifest 里声明的权限。不要加载别人发给你的文件夹。

### 开发者工具

开发者模式下，插件卡片下方有「开发者工具」按钮：面板、浮层、后台。插件对应的页面在运行时才能点。打开后和浏览器的开发者工具一样，可以看 console、网络、元素，打断点。

签名安装的正式插件不能打开开发者工具。

### 插件日志

开发者模式下方的「插件日志」会显示：

- 插件里的 `console.log` / `console.warn` / `console.error`，以及未捕获的报错，带文件名和行号；
- 页面没有加载成功、插件进程崩溃、持续未响应、超过内存限额；
- 每次加载成功的版本号。

只保留最近 200 条，重启 Relink 后清空，可以一键复制。正式插件不收集 console 输出。

### 清单没有通过检查

加载时如果 manifest 有问题，开发者模式会直接说明哪里不对，例如：

> 插件清单未通过检查：…这些域名不能用："https://api.deepseek.com"。只写域名本身，不要带 https:// 或路径。

也可以先在命令行检查，顺便看安装时会向用户说明哪些权限：

```sh
node tools/validate.cjs ../my-plugin
```

## 4. Relink 的宿主行为（容易踩的地方）

| 现象 | 原因 | 怎么做 |
| --- | --- | --- |
| 发到频道的回答里出现 `**`、`#` | 消息默认按纯文本显示 | 发送时加 `format: 'markdown'`；支持的写法见 api-v4.md（不支持表格和图片） |
| 回答要等很久才一次性出现 | 用的是 `fetch`，等全部生成完才返回 | 先 `sendChat({ pending: true })`，再用 `fetchStream` 边收边 `editChat` |
| `editChat` 报「只能修改…自己发的消息」 | 不是这个插件发的，超过 15 分钟，或 Relink 重启过 | 用 `sendChat` 返回的 `id`，及时完成回答 |
| 频道里一直显示「正在生成…」 | 最后一次 `editChat` 还带着 `pending: true`，或插件中途出错 | 完成时调用一次不带 `pending` 的 `editChat`；出错时 `deleteChat` |
| `getChat()` 返回 `available: false` | Room 域主没有允许插件读取消息（默认不允许），或没有打开文字频道 | 看 `reason`，提示用户去 Room 设置 → 插件 里打开 |
| `sendChat` 报「域主没有允许插件发消息」 | 这个 Room 关闭了插件发消息 | 用 `notify` 告诉用户 |
| 消息被截断或发送失败 | 单条消息最多 4000 字，每分钟最多 20 条 | 发送前自己截断 |
| `fetch` 报「插件没有声明访问 …」 | 域名不在 `network` 里 | 在 manifest 里加上，用户更新时会再次确认权限 |
| `fetch` 报「请先在 设置 → 插件 中填写…」 | 用户还没填密钥 | 调用前先 `getSecretStatus()` 检查，用 `notify` 提示 |
| 请求过于频繁 | 联网每分钟 60 次、同时 4 个；通知每分钟 6 条 | 合并请求，避免循环里调用 |
| 后台页面没有反应 | 插件没开启，或用户没登录 | 后台页面只在插件开启且已登录时运行 |
| 插件命令不出现 | `chatCommands` 没写，或缺少 `chat.commands` 权限 | 用 `validate.cjs` 检查 |

完整接口见 [api-v4.md](api-v4.md) 和 [index.d.ts](../index.d.ts)。

## 5. 提交审核

调试完成后用 `tools/pack.cjs` 打包，按 [publishing.md](publishing.md) 提交。审核通过的签名包才能被普通用户安装。
