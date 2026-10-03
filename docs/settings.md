# 作者与独立设置

Relink 1.0.6 的「设置 → 插件」会显示签名包中的作者名称、头像，并在每个插件下提供可展开的「插件设置」。设置按插件 ID 分别保存，重启后保留。安装后的插件默认关闭。

在 manifest.json 中声明作者与设置，例如：

```json
{
  "author": { "name": "Nightsuzu", "avatar": "author.png" },
  "settings": [
    { "key": "orbit", "label": "环绕光效", "type": "toggle", "default": true },
    { "key": "notchTransparency", "label": "游戏刘海透明度（%）", "type": "range", "min": 0, "max": 85, "step": 5, "default": 15 }
  ]
}
```

头像是包内 PNG 或 WebP 文件，最多 200 KB。最多声明 12 个设置，支持布尔开关和整数滑条。滑条值必须满足范围和步长；未知设置键会被拒绝。作者、头像和设置定义都参与发布签名，修改后需要重新审核授权。

插件可调用 `window.relinkPlugin.getSettings()` 读取，`updateSettings({ orbit: false })` 保存部分设置，`onSettings(callback)` 订阅变化并在卸载时调用返回的取消订阅函数。宿主限制写入频率，因此滑条拖动时在本地预览，松开后再保存。插件不能读取或更改其他插件的设置。

客户端中的设置修改会即时同步给已开启的插件，插件中的修改也会同步回设置页。通用的显示器、显示时机与插件自身选项在同一个下拉区域中管理。
