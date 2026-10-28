# 插件 API v3

API v3 在 v1/v2 的桌面浮窗之外增加了四项能力：说话者与成员状态、通话按钮、客户端内嵌面板，以及宿主信息。还提供了供作者调试用的「插件开发者模式」。旧的 v1/v2 插件不用改动，仍然可以使用。

## 开放原则

Relink 客户端闭源，插件生态开源。v3 在下面几条前提下尽量多开放接口：

- **插件不能联网。** 所有页面都使用 `connect-src 'none'` 的内容安全策略，也不能发起下载、打开新窗口、嵌入 iframe 或 worker。插件读到的数据只能留在这台电脑上。
- **拿不到身份。** 插件读不到账号 ID、用户 ID、手机号或令牌。成员 ID 是按插件区分的匿名标识，只在本次运行期间保持不变，不同插件之间无法互相对应。
- **拿不到内容。** 插件读不到聊天消息、私信、音频和屏幕画面。
- **按权限声明。** 每项数据都对应 manifest 里的一个权限，安装时会逐条告诉用户。新版本增加权限时，需要用户再次确认。
- **由客户端控制位置。** 插件按钮和面板放在哪、什么时候显示，都由 Relink 决定，插件不能自行移动或打开它们。

如果你需要的接口不在这些范围内，请到插件中心提交需求，并说明用途。

> API v4 起，联网、频道聊天、密钥等能力可以按权限申请，见 [api-v4.md](api-v4.md)。上面的前提仍然适用于只声明 v3 权限的插件。

## manifest.json

```json
{
  "id": "speakers-board",
  "name": "说话者看板",
  "version": "0.1.0",
  "apiVersion": 3,
  "description": "在语音页右侧面板显示谁在说话。",
  "capabilities": ["voice.participants"],
  "commands": [{ "id": "mark", "title": "标记此刻", "icon": "mark.svg" }],
  "panel": { "entry": "panel.html", "title": "说话者" }
}
```

| 字段 | 说明 |
| --- | --- |
| `apiVersion` | 使用下面任意一项 v3 功能时必须写 `3`。 |
| `entry` | 桌面浮窗页面。v3 插件只有面板时可以省略。 |
| `panel` | `{ entry, title }`：显示在语音页右侧、「频道聊天」旁边的标签页。`title` 最多 12 个字。 |
| `commands` | 1–4 个按钮：`{ id, title, icon? }`。`id` 由 2–32 位小写字母、数字或 `-` 组成；`title` 最多 16 个字；`icon` 是不超过 16 KB 的 SVG 资源。 |
| `capabilities` | 新增 `voice.participants`。 |

打包前先运行：

```sh
node tools/validate.cjs <插件文件夹>
```

它会用中文指出 manifest 的问题，并列出安装时会向用户说明的权限。

## 宿主信息：`getHostInfo()`

不需要申请权限。插件可以用它判断当前客户端支持哪些功能，从而在旧版客户端上降级运行。

```js
const info = await window.relinkPlugin.getHostInfo?.();
// { apiVersion: 3, supportedApiVersions: [1, 2, 3], client: '1.1.2',
//   surface: 'overlay' | 'panel', capabilities: [...], commands: ['mark'], panel: true, developer: false }
```

`getHostInfo` 等 v3 方法在旧客户端上不存在，调用前请先检查。

## 说话者与成员状态（`voice.participants`）

```js
const people = await window.relinkPlugin.getParticipants();
const stop = window.relinkPlugin.onParticipants(people => render(people));
// [{ id: 'k3J…', name: '小雨', self: false, speaking: true, muted: false, deafened: false }]
```

- 只包含当前语音频道里的成员，不在通话中时返回空数组。
- 有变化时推送，最快约每秒 10 次。`speaking` 是开或关的状态，不包含音量数值。
- `id` 是匿名标识：本次运行期间稳定，不同插件拿到的不同，也无法换算成账号。
- `name` 是 Relink 里显示的昵称。插件不能联网，所以昵称不会离开这台电脑。

适合做直播用的「正在说话」叠加层、发言计时、说话者看板这类插件。

## 通话按钮（`commands`）

声明了 `commands` 的插件运行时，Relink 通话控制里会出现一个「插件按钮」菜单，列出这些按钮。用户点击后，插件会收到：

```js
window.relinkPlugin.onCommand(command => {
  if (command.id === 'mark') markMoment();
});
```

插件只能知道哪个按钮被按下，不能自己添加或触发按钮。每个插件每秒最多接收 8 次按钮事件。

## 客户端内嵌面板（`panel`）

声明了 `panel` 的插件会在语音页右侧多出一个标签页，标签名就是 `title`。用户切到这个标签时，Relink 才在相应位置加载 `panel.entry`。

- 面板和浮窗属于同一个插件，使用同一套隔离环境、同一份设置和同样的权限。`getState`、`getMedia`、`getParticipants` 等接口在面板里同样可用。
- 面板里的页面不能调整浮窗大小，`setDisplayState` 和 `expand`/`collapse` 只对浮窗有效。
- 面板的大小随右侧栏变化，常见尺寸约为宽 280–360、高 400–800。请按自适应布局设计。
- Relink 的菜单、资料卡或设置面板打开时，插件面板会暂时隐藏，关闭后自动恢复。
- 同一时间只显示一个插件面板，切走标签后面板会被卸载。需要保留的数据请存进插件设置里。
- 运行中的插件最多 3 个，浮窗和面板合计计算。每个插件的内存上限是 192 MiB，浮窗和面板分别计算。

本地预览面板：`node tools/preview.cjs <文件夹>`，然后打开它输出的 `/panel` 地址。预览会模拟三位轮流说话的成员，左下角有通话按钮可以点。

## 插件开发者模式

用来在正式客户端里调试还没提交审核的插件：

1. 打开 **设置 → 插件 → 插件开发者模式**，在确认框里选择打开。
2. 点「选择插件文件夹」，选中包含 `manifest.json` 的文件夹。
3. 修改并保存文件后，插件会自动重新加载，也可以手动点「重新加载」。

限制：

- 只在本次运行有效，重启 Relink 后自动关闭。
- 一次只能加载一个文件夹，插件 ID 不能和已安装的正式插件重复。
- 窗口底部会一直显示红色的「插件开发者模式」提示条，插件旁边标有「开发中」。
- 开发中的插件使用和正式插件一样的隔离环境：不能联网，读不到账号、聊天和私信。
- 不会改变正式插件的规则：未签名或被篡改的 `.rlplugin` 安装包仍会触发安全退出。

**不要加载别人发给你的文件夹。** 需要分发的插件，请走审核和签名流程（见 [publishing.md](publishing.md)）。

## 兼容写法

```js
const bridge = window.relinkPlugin;
const info = await bridge.getHostInfo?.().catch(() => null);
if (info?.capabilities.includes('voice.participants')) {
  bridge.onParticipants(renderSpeakers);
} else {
  bridge.onState(state => renderCount(state.memberCount)); // v1/v2 回退
}
```
