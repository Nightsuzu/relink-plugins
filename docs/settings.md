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

头像是包内 PNG 或 WebP 文件，最多 200 KB。最多声明 12 个设置，支持布尔开关和整数滑条；API v4 起还支持文字、多行文字和下拉选择（见下文）。滑条值必须满足范围和步长；未知设置键会被拒绝。作者、头像和设置定义都参与发布签名，修改后需要重新审核授权。

插件可调用 `window.relinkPlugin.getSettings()` 读取，`updateSettings({ orbit: false })` 保存部分设置，`onSettings(callback)` 订阅变化并在卸载时调用返回的取消订阅函数。宿主限制写入频率，因此滑条拖动时在本地预览，松开后再保存。插件不能读取或更改其他插件的设置。

客户端中的设置修改会即时同步给已开启的插件，插件中的修改也会同步回设置页。通用的显示器、显示时机与插件自身选项在同一个下拉区域中管理。

## 文字、多行文字和下拉选择（API v4）

```json
"settings": [
  { "key": "model", "label": "模型", "type": "select", "default": "deepseek-chat",
    "options": [{ "value": "deepseek-chat", "label": "对话" }, { "value": "deepseek-reasoner", "label": "推理" }] },
  { "key": "nickname", "label": "称呼", "type": "text", "default": "", "placeholder": "AI 怎么称呼你", "maxLength": 20 },
  { "key": "prompt", "label": "自定义提示词", "type": "textarea", "default": "", "maxLength": 2000 }
]
```

| type | 值 | 限制 |
| --- | --- | --- |
| `text` | 一行文字 | `maxLength` 1–500（默认 500），不能换行；`placeholder` 最多 60 字 |
| `textarea` | 多行文字 | `maxLength` 1–4000（默认 4000）；`placeholder` 最多 60 字 |
| `select` | 选中的 `value` | 2–20 个 `options`，`value` 最多 64 字且不重复，`label` 最多 40 字；`default` 必须是其中一个 `value` |

这三种需要 `"apiVersion": 4`。文字在输入框失去焦点（单行文字按回车）时保存，不会每输入一个字就保存一次。

**不要把 API Key 之类的密钥放在设置里。** 设置值插件能读到明文，保存在本机设置文件里；密钥请用 `secrets`（系统加密保存，插件读不到明文），见 [api-v4.md](api-v4.md)。
