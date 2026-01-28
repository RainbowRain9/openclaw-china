# @moltbot-china/dingtalk

钉钉 (DingTalk) 渠道插件，为 Moltbot 提供钉钉消息接入能力。

## 实现状态

✅ **已完成的核心功能：**

- 类型定义和配置 Schema
- Stream Client 和 Token 管理
- 消息接收和解析
- 策略检查（DM/群聊白名单、@提及要求）
- Stream 连接管理
- 消息发送（文本和媒体）
- ChannelPlugin 完整实现

⏸️ **可选功能（未实现）：**

- 渠道状态监控 (status adapter)

## 如何接入 Moltbot

### 1. 安装插件

将 `extensions/dingtalk` 目录复制到 Moltbot 的扩展目录：

```bash
# 方式一：复制到 Moltbot 工作区扩展目录
cp -r extensions/dingtalk <moltbot-workspace>/.clawdbot/extensions/

# 方式二：复制到全局扩展目录
cp -r extensions/dingtalk ~/.clawdbot/extensions/
```

### 2. 配置钉钉凭证

在 Moltbot 配置文件中添加钉钉渠道配置：

```json5
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "你的钉钉应用 AppKey",
      "clientSecret": "你的钉钉应用 AppSecret",

      // 单聊策略: "open" | "pairing" | "allowlist"
      "dmPolicy": "pairing",

      // 群聊策略: "open" | "allowlist" | "disabled"
      "groupPolicy": "allowlist",

      // 群聊是否需要 @机器人
      "requireMention": true,

      // 单聊白名单（dmPolicy 为 allowlist 时使用）
      "allowFrom": ["user_id_1", "user_id_2"],

      // 群聊白名单（groupPolicy 为 allowlist 时使用）
      "groupAllowFrom": ["conversation_id_1"]
    }
  }
}
```

### 3. 钉钉开放平台配置

1. 登录 [钉钉开放平台](https://open.dingtalk.com/)
2. 创建企业内部应用
3. 开启「机器人」能力
4. 配置消息接收模式为 **Stream 模式**
5. 获取 AppKey (clientId) 和 AppSecret (clientSecret)

### 4. 启动 Moltbot

```bash
moltbot start
```

插件会自动：

- 建立 Stream 长连接
- 监听机器人消息
- 根据策略处理消息
- 将消息分发给 Agent

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用钉钉渠道 |
| `clientId` | string | - | 钉钉应用 AppKey |
| `clientSecret` | string | - | 钉钉应用 AppSecret |
| `dmPolicy` | string | `"pairing"` | 单聊策略: `open`/`pairing`/`allowlist` |
| `groupPolicy` | string | `"allowlist"` | 群聊策略: `open`/`allowlist`/`disabled` |
| `requireMention` | boolean | `true` | 群聊是否需要 @机器人 |
| `allowFrom` | string[] | `[]` | 单聊白名单用户 ID |
| `groupAllowFrom` | string[] | `[]` | 群聊白名单会话 ID |
| `historyLimit` | number | `10` | 历史消息数量限制 |
| `textChunkLimit` | number | `4000` | 文本分块大小限制 |

## 策略说明

### 单聊策略 (dmPolicy)

- `open`: 允许所有用户私聊
- `pairing`: 需要配对确认（推荐）
- `allowlist`: 仅允许白名单用户

### 群聊策略 (groupPolicy)

- `open`: 允许所有群聊（需 @提及）
- `allowlist`: 仅允许白名单群组
- `disabled`: 禁用群聊功能

## 开发

```bash
# 安装依赖
pnpm install

# 运行测试
pnpm test

# 类型检查
pnpm typecheck
```

## 许可证

MIT
