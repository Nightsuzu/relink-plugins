# 音乐与频道接口

这些是 API v1 的可选扩展，类型见 `index.d.ts`。旧宿主可能没有对应方法；插件必须检测方法存在并声明所需能力。声明新能力的包需要重新审核签署。

## 音乐状态

`getMedia()` 需要 `music.read`，返回可用性、采样时间、锁定的 `activeSource` 和该播放器的媒体会话。宿主按播放器进程启动时间选择最早启动者，暂停、切歌或其他播放器开始播放均不抢占；只有原进程退出才重新选择。进程存在但没有 SMTC 数据时返回空会话并保留来源，不伪造播放状态。宿主只枚举白名单进程名称和启动时间，不向插件暴露 PID、路径或命令行。

已设置 Windows SMTC 来源白名单：QQ 音乐 `QQMusic.exe`、网易云音乐 `cloudmusic.exe`、汽水音乐 `soda.exe` / `SodaMusic.exe`。这表示允许接入这些系统会话，不代表每个版本的播放器都提供全部能力。播放器关闭系统媒体控制、没有公开会话或未支持 SMTC 时，返回空列表。没有读取播放器账号、cookies、私有数据库、音频或窗口内容。

封面由独立宿主解码并缩至最大 160 像素，以受限 PNG data URL 返回。插件不能通过该接口获取任意图片 URL。数据停留在本机内存，关闭音乐插件后释放。

```js
const media = await window.relinkPlugin.getMedia();
const track = media.sessions[0];
if (track?.controls.pause) {
  await window.relinkPlugin.controlMedia({
    session: track.id, track: track.track, action: 'pause'
  });
}
```

`controlMedia` 需要 `music.control`，动作仅为 `play`、`pause`、`previous`、`next`。使用当前返回的会话 ID；会话已关闭、能力不支持或播放器拒绝时请求失败。切换曲目不会阻止连续的下一首或播放操作，最多串行排队 3 个控制请求。操作后重新取状态，不要把发送成功当作播放状态已经改变。不会发送全局媒体快捷键。

## 歌词

同时声明 `music.lyrics` 后，宿主把正在播放歌曲的名称、歌手、专辑及长度发送到 `https://lrclib.net/api/get`，不发送 Relink 账户数据。匹配会核对这些字段；错误版本、找不到歌词、服务超时或纯音乐有不同状态。响应最大 200 KB，最长等待 5 秒，缓存最多 24 首；插件自身仍不能联网。

`lyrics.lines` 是带毫秒时间的 LRC 行。`positionMs` 是宿主采样进度，播放器播放时可在 `updatedAt` 基础上做最多 2.5 秒的外推；下一次采样重新校正。


## 频道

`getChannels()` 需要 `channels.read`，只返回当前 Room 的语音频道、当前通话标记和密码锁定标记。`switchChannel({scope,id})` 需要 `channels.switch`。必须传回原快照的 scope，过期 Room、锁定频道或离线状态会拒绝操作。

主客户端负责真实 `joinVoice`，并在当前通话状态确认后回复。插件不得绕过 Room 权限、密码、人数限制或禁言规则。服务端校验照常执行。宿主没有取得确认时返回错误，避免显示虚假的成功状态。

## 宿主集成

Windows 10 1809 及以上；需要 Windows SDK 与 MSVC C++20 来编译独立桥接程序：

```powershell
./native/build.ps1
```

把 `native/bin/RelinkMediaBridge.exe` 放入应用资源目录 `plugin-native/RelinkMediaBridge.exe`。它是宿主的组件，不允许插件上传自己的 EXE/DLL。源代码在 `native/media-bridge.cpp`，没有外部原生依赖。失败或超时只终止这一个桥接进程，不影响通话/屏幕共享进程。

主窗口增加可信 IPC：`relink:plugins:channels` 发布频道快照；监听 `relink:plugins:switch-channel`，调用正常的加入频道流程，在真实状态确认后用 `relink:plugins:channel-result` 回复 `{requestId,ok}`。主窗口关闭、断线、登录变化或 Room 改变时应清空快照。不能用插件提供的路径读取任何文件。

参考：[Microsoft SMTC 会话接口](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssession)、[LRCLIB 文档](https://lrclib.net/docs)。
