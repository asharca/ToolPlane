# Agent 消息平台

> **English**: [AGENT_MESSAGING_PLATFORMS.md](./AGENT_MESSAGING_PLATFORMS.md)

## 频道管理

工作区 Settings > Channels 页面（`/app/[workspace]/settings/channels`）和每个 Agent 的
Channels 标签页共用同一套平台侧栏、实例行、凭据编辑器、连接开关、删除确认和实时日志
弹窗。交互参考 Cherry Studio 的 `ChannelsSettings` 功能。Feishu、Telegram、QQ、WeChat、
Discord、Slack 按相同顺序展示。

频道可以先创建为未绑定的草稿。绑定 Agent 之后才能启动 runner。删除 Agent 不会连带删除
频道，频道可以重新绑定；删除频道会停止 runner，但保留会话历史。服务器启动时会恢复之
前标记为 running 或 starting 的已绑定频道；已停止的频道和不完整的草稿保持停止。
ToolPlane 保留自己的工作区鉴权和 Agent 沙箱执行模型，不引入 Cherry Studio 的 Electron
IPC 或宿主机目录访问。

管理接口为 `GET/POST /api/v1/workspaces/[slug]/agent-channels`，支持账户 Bearer token
或会话 Cookie。POST 动作包括 `create`、`update`、`delete`、`start`、`stop`、`pair`、
`check`、`apply`、`move`。`GET ?logs=[connectionId]` 在工作区鉴权后返回内存中最近 200
行日志。已知密钥会脱敏，任何管理响应都不包含 runner 或入站 token。非密钥配置值可读可
清空。密钥字段留空表示保留已加密存储的原值。编辑运行中的连接会将其重启。

频道会话按连接 ID 和上游 chat 共同键控，绑定同一 Agent 的两个机器人不会意外共享历史。
`/whoami` 返回上游 ID，`/new` 开启新会话。用户/chat 白名单在 Agent 执行之前检查，包括 HTTP 交接边界这一层。

频道会话出现在 Work 侧栏 Channels 分组中对应 Agent 之下。它们是普通的
`Conversation`/`Message` 历史，不是 Work 会话。选中会话会跳转到
`/app/[workspace]/work?agent=[agentId]&c=[conversationId]`，复用现有 Work 界面及其侧
栏、搜索和沙箱工具。`/app/[workspace]/chat` 保留给助手使用；旧的 Agent chat 路由重定
向到 Work。频道历史在控制台中为只读，每五秒刷新。迁移后旧历史仍归原 Agent。

飞书/Lark 注册使用扫码设备流程，自动保存返回的 App ID 和 App Secret。微信使用现有的
iLink 配对流程。轮询在完成、过期、失败或关闭编辑器时停止。主要凭据字段与参考实现一致；
ToolPlane 额外策略和微信手动凭据保留在 Advanced 之下。

各平台的接入方式没有统一 URL。每个生态有自己的配置界面：bot token 表单、Socket Mode
应用、扫码、本地 daemon、邮箱收件箱或公开 webhook 回调。

ToolPlane 平台负责原生频道工作和 Agent 执行。一个频道连接属于一个 Agent，代表一个配
置好的外部生态入口。

## 会话操作

频道支持 `/new`、`/help`、`/whoami` 以及 Agent runtime 的自有命令。命令与同一 chat 的
传入消息按序处理。`/new` 把后续消息切到新会话，不删除之前的历史；`/help` 和 `/whoami`
不进入模型上下文。频道配置弹窗列出这些命令。`/new` 仅频道可用；Work 输入框使用
**New task** 动作。

Agent Work 头部还提供 Compact context 和 New channel conversation 控件。普通 Work 会话
保留自己的 New work 控件。操作绝不会把控制台文本作为频道消息发出，也不会把用户带进
助手界面。

Work 输入框在 `+` 和 `/` 之间共享一个六项菜单：附件、已存 prompt 管理、MCP prompts、
MCP resources、用户可调用的已绑定 skills、New task。占位符说明 `/` 和 `@` 的用法。
`@` 在当前沙箱中搜索文件和会话（包括频道历史），排除当前会话。引用读取会校验工作
区、Agent 和沙箱归属。选中的引用以可移除 chip 呈现，作为带引用元数据的 text part 持久
化，并进入 runtime 上下文。Prompt 模板按 Agent 存储，不存浏览器。菜单的 **Customize
toolbar** 项可以固定/取消固定动作、拖拽按钮排序、恢复默认。固定的动作离开根菜单；
工具栏偏好在本浏览器内跨 Work 会话持久化。

沿袭 Cherry 的做法，`/` 也列出 runtime 命令（而非额外的 `+` 工具）：Pi 提供
`/compact [focus]`；Claude Code 提供 `/clear`、`/compact [focus]`、`/context`、`/usage`；
DSH 提供 `/compact` 和 `/goal`（带其原生 objective/edit/pause/resume/clear 参数）。运
行中的 Claude/DSH 命令注册表可以为当前会话增加第三方命令。选中即插入命令，提交即执
行。不支持的命令绝不会变成普通模型 prompt。

命令通过原生 runtime 执行，不在宿主机侧模拟。Work 命令与普通轮次使用相同的协调器和
runtime 配置。Claude Code 和 Pi 通过沙箱本地 Unix socket 在轮次间保留 CLI 会话；空闲进
程两分钟后停止，后续轮次恢复原生会话文件。DSH 恢复其原生持久化会话和命令注册表。每
个 ToolPlane 会话有独立的原生会话。压缩改变该原生会话的活动上下文，`/new` 另起一个
会话。既有平台历史只在首次使用时导入，不会在原生压缩上重放。Claude `/usage` 返回与
其认证模式匹配的原生输出，绝不是平台估算的统计面板。命令输出作为普通助手回复存储和渲染，支持复制（包括旧命令记录）；控制类读数不进入模型上下文。

Hermes 的压缩逐字保留最近的若干轮，并保存一条包含
`data-conversation-compaction` part 的系统消息。原始消息和附件保持不变。Work、控制台
chat 和频道轮次会把最新摘要加上其边界之后的消息投影进 runtime；界面仍显示完整历史。
Hermes 会换一个新的 runtime 会话别名，并以保留下来的上下文作为种子。失败、取消、繁忙或无法
缩减的压缩不会改变历史。显示的 token 缩减量是估算值。压缩和新会话动作使用与传入轮次
相同的工作区/Agent 鉴权和每会话准入闸门。不涉及任何 Hermes 平台适配器。

## 职责划分

平台频道层负责：

- 原生应用创建、OAuth、bot token、扫码配对或 daemon 会话
- 签名校验和 challenge 握手
- 平台白名单和频道/用户策略
- 轮询、WebSocket、webhook、IMAP 或 bridge 事件接收
- 文件/媒体下载与上传
- 通过平台 SDK 完成最终回复投递

Agent runtime 负责：

- 工作区和 API token 鉴权
- Agent 模型/工具/skill/沙箱解析
- 会话与消息持久化
- 从来源元数据派生稳定的 `sessionKey`
- 有意静默（intentional silence）处理

## 原生传输

频道适配器改编自 Cherry Studio 的 Node 频道实现，对应 revision
c03519c028cfe25e32060ad7dcdeea531f22fd46。见 `src/lib/agents/channels/NOTICE` 和保留
的 AGPL 许可证。Electron IPC、宿主目录凭据存储和 Cherry 的 Agent 执行器不在其中。

| 平台 | 原生传输 | 凭据 |
| --- | --- | --- |
| Telegram | grammY Bot API 轮询 | Bot token |
| 飞书 / Lark | 官方 Lark Node SDK WebSocket | App ID 和 secret |
| QQ | 官方机器人 REST API 和 WebSocket 网关 | App ID 和 secret |
| 微信 | 腾讯 iLink 轮询与加密媒体 | 扫码签发的 token 和账户 ID |
| Discord | REST API 和 Gateway WebSocket | Bot token |
| Slack | REST API 和 Socket Mode | Bot token 和 app token |

`channel-runtime.ts` 在常驻 Node 服务器中管理这些适配器。入站消息直接调用
`runAgentChannelMessage`，回复使用同一适配器。没有 Python 进程，没有 Hermes 平台导
入，也没有 Hermes checkout 路径。DSH、Pi、Claude Code 和 Hermes Agent runtime 各自保
留执行路径；频道传输从不选择 Agent runtime。

企业微信（WeCom）和钉钉的旧记录保留，但其旧的基于 Hermes 的托管启动器不可用，也不作
为新原生频道提供。回调集成保持独立，且必须对交接进行鉴权。

## 沙箱归属与迁移

每个沙箱有一个 Channels 标签页。`AgentChannelConnection.sandboxId` 限定其配置范围；绑
定的 Agent 从该沙箱的分配关系解析。现有 Agent 频道会被回填到该 Agent 的 runtime/默认
沙箱。未分配的沙箱可以接受草稿配置，但在分配 Agent 前不能启动回复。托管公网端点沙箱
除外。

工作区列表仍可用于管理所有频道，包括未分配的草稿。`GET ?sandboxId=...` 只返回该沙箱
的频道。`POST { action: "move", connectionId, sandboxId }` 把频道移动到同一工作区的
另一个沙箱。移动前先停止旧适配器并中止进行中的轮次再重新绑定。凭据、配对状态、连接
ID 和入站 token 保持不变，因此迁移不需要重新扫码。活跃频道会对目标 Agent 重启。没有
Agent 的目标收到一个停止的草稿。重启失败会回滚原绑定。

历史仍归原 Agent；目标 Agent 开启自己的会话。调用方不能复用原 Agent 的会话 ID。已排
队的旧消息和迟到的适配器事件在移动后不能再回复。Runtime 轮次会显式收到频道的沙箱
ID，包括 DSH。

服务器恢复和适配器状态都是单进程的。每个频道队列深度上限 20 条待处理消息；日志在内
存中保留最近 200 行。要用同一套 bot 凭据运行多个应用副本，请先引入持久队列和分布式
归属。

## 接入流程类型

平台目录在 `src/lib/agents/platforms.ts`。每个条目包含 `setupFlow`、凭据字段、配置步
骤、连接模式，以及是否真的需要公网回调 URL。

示例：

| 平台 | 流程 | 用户第一步 | 需要公网回调？ |
| --- | --- | --- | --- |
| Telegram | Bot Token | 粘贴 BotFather token 和允许的 Telegram ID | 否 |
| 企业微信 | 扫码 | 扫企业微信二维码；回退为 Bot ID + Secret | 否 |
| 微信 | 扫码 | 扫微信二维码进行 iLink 登录 | 否 |
| Slack | Socket Mode | 粘贴 `xoxb-` bot token 和 `xapp-` app token | 否 |
| Discord | Gateway Bot | 粘贴 bot token 并启用 privileged intents | 否 |
| WhatsApp Cloud | Cloud Webhook | 配置 Meta 应用凭据和回调 URL | 是 |
| 企业微信回调 | Webhook Callback | 创建自建应用和加密回调 | 是 |
| LINE | Webhook Callback | 配置 Messaging API 频道 webhook | 是 |
| SimpleX | 本地 Daemon | 把平台 worker 指向 `simplex-chat` WebSocket daemon | 否 |
| ntfy | Topic Subscribe | 让平台 worker 订阅一个 topic | 否 |

## 扫码与配对流程

有些平台不能只靠静态 token 表单配置：

- Telegram 托管机器人设置显示扫码深链；扫码创建机器人，但用户仍须确认允许的数字
  Telegram 用户 ID 后 ToolPlane 才保存 token。
- 企业微信 AI Bot 设置显示二维码；扫码返回 Bot ID 和 Secret。
- 微信/iLink 登录显示二维码；扫码返回账户/会话数据。
- WhatsApp bridge 设置显示必须在手机 App 中扫描的配对二维码。
- Signal 链接以 `signal-cli link` URI 开始，应渲染为二维码。

ToolPlane 把这些建模为两阶段频道连接：

```text
create channel -> request QR -> user scans -> poll provider -> save credentials -> stopped -> running
```

Telegram 多一步确认，与 Hermes 一致：

```text
create channel -> request QR -> user scans -> poll ready -> confirm allowed user IDs -> save credentials -> stopped -> running
```

对支持扫码的平台，UI 不要求用户粘贴二维码载荷。ToolPlane 主动调用平台设置端点，把
短期配对会话存进频道配置，渲染返回的二维码内容，并轮询平台等待扫码完成。提供方返回
凭据后，ToolPlane 将其加密存到频道上。

当前活跃的扫码提供方：

| 平台 | 二维码请求 | 轮询结果 | 保存的凭据 |
| --- | --- | --- | --- |
| Telegram | `setup.hermes-agent.nousresearch.com/v1/telegram/pairings` | 托管机器人就绪 + bot token + 所有者用户 ID | 用户确认后的 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_USERS` |
| 企业微信 | `work.weixin.qq.com/ai/qc/generate` | `work.weixin.qq.com/ai/qc/query_result` | `WECOM_BOT_ID`、`WECOM_SECRET` |
| 微信 | `ilink/bot/get_bot_qrcode` | `ilink/bot/get_qrcode_status` | `WEIXIN_ACCOUNT_ID`、`WEIXIN_TOKEN`、`WEIXIN_BASE_URL` |

WhatsApp、Signal、元宝等 bridge 平台使用相同的 UI 契约，但仍需要一个 ToolPlane 设置
runner 来启动原生 bridge、接收其二维码/链接事件并向频道回报完成。标记为
`requiredAt: "start"` 的凭据在频道首次创建时不需要；在托管 runner 启动前必须提供。

## 端点

每个 Agent 仍暴露一个通用内部端点：

```text
POST /api/v1/agents/:agentId/messages
```

配置好的频道使用按连接的端点：

```text
POST /api/v1/agent-channels/:connectionId/events
```

该端点在用户于 Agent UI 中创建频道连接时生成。它是原生平台处理与 ToolPlane Agent
runtime 之间的边界。例如：

- Telegram 设置从 `TELEGRAM_BOT_TOKEN` 开始；托管 runner 随后接收 Telegram 更新并调用
  ToolPlane。
- Slack 设置从 Socket Mode token 开始；Slack 事件经平台持有的 WebSocket 到达。
- 微信设置从扫码开始；原生传输长轮询 iLink。
- WhatsApp Cloud 确实需要公网 HTTPS 回调，因为 Meta 通过 webhook 投递消息。

频道交接端点要求生成的频道 token：

```text
Authorization: Bearer <toolplane-channel-token>
```

对无法发送自定义 Authorization 头的 webhook 产品，频道端点也接受 query token：

```text
POST /api/v1/agent-channels/:connectionId/events?token=<toolplane-channel-token>
```

通用 API token 供内部服务和自定义集成经 `/api/v1/agents/:agentId/messages` 使用，不
是常规的原生频道路径。

## 归一化交接格式

托管 runner 和回调处理器可以在 ToolPlane 有归一化器时向频道端点发送原生载荷，也可以
直接发送归一化格式：

```json
{
  "message": "hello",
  "source": {
    "platform": "slack",
    "chatType": "channel",
    "chatId": "C123",
    "userId": "U123",
    "threadId": "1720000000.000100",
    "messageId": "1720000000.000200"
  }
}
```

## 响应契约

托管 runner 和回调处理器按 `delivery` 字段分支。

```json
{
  "agentId": "agent-id",
  "conversationId": "conversation-id",
  "delivery": "message",
  "message": "Reply to send back to the platform.",
  "rawMessage": "Reply to send back to the platform.",
  "sessionKey": "msg:slack:channel:C123:1720000000.000100",
  "source": {
    "platform": "slack",
    "chatType": "channel",
    "chatId": "C123",
    "userId": "U123",
    "threadId": "1720000000.000100"
  }
}
```

如果 Agent 最终回复恰好是 `[SILENT]`、`SILENT`、`NO_REPLY` 或 `NO REPLY`，ToolPlane
返回：

```json
{
  "delivery": "silent",
  "message": "",
  "rawMessage": "NO_REPLY"
}
```

该助手轮次仍会持久化在会话记录中。

## 支持的平台 slug

- `api`
- `webhooks`
- `open_webui`
- `telegram`
- `discord`
- `slack`
- `google_chat`
- `whatsapp`
- `whatsapp_cloud`
- `signal`
- `sms`
- `email`
- `homeassistant`
- `mattermost`
- `matrix`
- `dingtalk`
- `feishu`
- `wecom`
- `wecom_callback`
- `weixin`
- `bluebubbles`
- `qqbot`
- `yuanbao`
- `teams`
- `teams_meetings`
- `msgraph_webhook`
- `line`
- `ntfy`
- `raft`
- `irc`
- `simplex`
- `photon`

Hermes 风格的连字符别名也被接受，如 `whatsapp-cloud`、`wecom-callback`、
`teams-meetings`、`msgraph-webhook`、`open-webui`。

## Hermes 参考

- [Telegram](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram)
- [WeCom](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/wecom)
- [Weixin](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin)
- [Slack](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack)
- [Discord](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord)
- [WhatsApp Cloud](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud)
- [WeCom Callback](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/wecom-callback)
