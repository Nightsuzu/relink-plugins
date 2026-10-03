# Relink Plugins

Relink 插件开发开源项目：SDK、打包工具、隔离宿主、授权校验与开发样例。本文档对应 **插件 API v1 / SDK 0.1.0**。代码开源许可与 Relink 客户端的发布授权分别管理。

[官网开发文档与提交入口](https://relinkus.cn/plugins/) · [审核与发布指南](docs/publishing.md)

桌面插件需要支持相应插件 API 的客户端。开发时使用独立预览环境，安装前核对插件与宿主版本的兼容性。

## 最小示例

`examples/hello-relink/` 演示读取状态、订阅变化和返回主窗口。先运行这个示例，再修改清单、界面和申请能力。

## 开发与打包

需要 Node.js 22 或更新版本；SDK 打包和校验无第三方依赖。

```sh
npm test
node tools/preview.cjs examples/hello-relink
node tools/pack.cjs examples/hello-relink hello-relink.unsigned.rlplugin
```

`manifest.json` 声明插件 ID、名称、版本、API 版本、入口和权限。示例只使用 HTML / CSS / JS。资源限定为同一目录的普通文件，最多 32 个，解码后的总资源最多 1 MiB，整个包最多 2 MiB。不支持本地 Node 模块、原生 DLL、网络地址和任意目录访问。

**未授权包用于审核，不要导入正式客户端。** 导入未授权插件会触发 Relink 的安全退出策略。`preview.cjs` 在本机启动使用模拟数据的独立浏览器预览，不连接 Relink，不要求授权，也不使用账户信息；正式客户端没有关闭校验的开发开关。预览只验证界面；生产沙箱与真实通话需要独立 Electron 宿主测试。

## 授权发布

1. 在 [官网插件开发中心](https://relinkus.cn/plugins/#submit) 上传 `.unsigned.rlplugin`，填写公开源码仓库、完整提交 SHA、许可证、联系邮箱、权限与素材说明。保存返回的查询凭证。
2. Relink 审核资源内容与权限，使用未公开的授权私钥签署该版本的内容摘要。
3. 获得 `.rlplugin` 授权包后，发布该原始包与源码。客户端先验证签名，再执行插件。
4. 每次修改资源、权限、入口、插件 ID 或版本，都必须重新审核、签署。授权不能转借到其他版本。

授权签名为 Ed25519，绑定插件 ID、版本、完整清单及逐文件 SHA-256 摘要。客户端只包含公钥。自行生成密钥并签署不能获得 Relink 正式客户端的授权。授权私钥及正式客户端的其他源代码不包含在此项目中。上传进入待审核队列，由 Relink 控制台核验并授权；提交不等于审核通过。

开源代码采用 MIT，可学习、修改和制作独立宿主；不得将修改版标识为 Relink 官方授权版本。MIT 不授予 Relink 商标使用权，也不意味着可跳过正式客户端的发布授权。

## v1 API

```js
const state = await window.relinkPlugin.getState();
const stop = window.relinkPlugin.onState(next => render(next));
await window.relinkPlugin.action('mute');
stop();
```

| 权限 | 功能 |
| --- | --- |
| `voice.read` | 接收经过裁剪的通话状态 |
| `voice.mute` | 切换当前麦克风静音 |
| `voice.deafen` | 切换当前拒听状态 |
| `app.show` | 返回 Relink 主窗口 |
| `window.resize` | 展开或收起插件胶囊 |

状态字段见 [index.d.ts](index.d.ts)。没有账户 ID、手机号、令牌、聊天记录、音频或桌面纹理。插件不会申请操作系统麦克风或录屏权限。每插件操作限制为每秒 8 次。

宿主最多安装 16 个、同时启用 3 个插件；单个插件连续两次超过 192 MiB 工作集预算时暂停。不同插件的窗口、权限与会话相互隔离，反复开启同一插件会复用其受限会话，关闭窗口后释放渲染进程。

## 宿主集成

`host/plugin-host.cjs` 导出 `PluginHost`。Electron 主进程在 ready 前注册 `relink-plugin` 为 standard / secure / supportFetchAPI 自定义协议，在 ready 后调用 `initialize()`。构造参数为 `app, BrowserWindow, session, screen, ipcMain, dialog, trustedIpc, getWindow, quit`。

可信主窗口使用以下固定 IPC；`trustedIpc` 必须同时检查主窗口、主 frame 和实际应用页面来源：

| 通道 | 用途 |
| --- | --- |
| `relink:plugins:list` / `configure` / `install` | 插件管理 invoke |
| `relink:plugins:publish` | 可信主窗口发布裁剪前状态；宿主再次裁剪 |
| `relink:plugins:changed` | 管理列表更新 |
| `relink:plugins:action` | 宿主向可信主窗口发送获准的操作 |
| `relink:plugins:shutdown` / `shutdown-ready` | 违规退出前的有限清理时间 |

插件窗口只使用 `host/plugin-preload.cjs`，不要复用应用主窗口 preload。应用 before-quit 调用 `dispose()`。示例官方授权包和公钥位于 `host/`；仅用于验证示例，私钥不公开。

每个插件使用单独的非持久会话、sandbox、context isolation、关闭 Node integration，禁止网络、子窗口、iframe、下载、设备权限、webview、worker 和未授权 IPC。读取到的已验证资源留在内存中，不直接将外部文件目录暴露给渲染器。[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)是宿主配置的参考。

## 故障与撤销

普通插件崩溃、无响应、内存超预算只暂停该插件；重新启用可恢复，不结束主通话。宿主每 10 秒核验已安装插件；文件删除、篡改、未授权、过期或被撤销时记录安全事件，隔离管理目录中的违规包，结束通话并退出 Relink，清理最多等待 1.2 秒。插件默认关闭，退出登录时窗口关闭。

公钥和撤销名单随受保护的客户端发布，支持撤销内容摘要、ID@版本及整个签发密钥。官网撤销立即阻止新的下载，并提供签名撤销清单；既有安装不会仅因官网下架自动停用，在线撤销清单是否被读取取决于宿主版本；离线客户端需要更新才能获得新名单。校验约束正式客户端管理的插件包，不声称能检测任意操作系统注入或经过修改的客户端。渲染器仍有额外内存成本，隔离不等于零开销，也不是操作系统级 CPU 配额。

## 项目文件

- `runtime/package.cjs`：格式、摘要、签名与撤销校验。
- `host/`：开源 Electron 插件宿主、权限策略和独立 preload。
- `examples/hello-relink/`：状态订阅与返回主窗口的最小开发示例。
- `tools/pack.cjs`：生成待审核包。
- `tests/`：授权边界测试。

请参阅 [SECURITY.md](SECURITY.md) 与 [LICENSE](LICENSE)。
