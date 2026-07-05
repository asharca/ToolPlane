# Agent Messaging Platforms

ToolPlane follows the Hermes gateway idea, but the important detail is that
platform onboarding is not one universal URL. Each ecosystem has its own setup
surface: a bot token form, a Socket Mode app, a QR scan, a local daemon, an
email inbox, or a public webhook callback.

The ToolPlane platform owns native channel work and agent execution. A channel
connection belongs to one agent and represents one configured external
ecosystem entry point.

## Responsibilities

The platform channel layer owns:

- Native app creation, OAuth, bot tokens, QR pairing, or daemon sessions
- Signature verification and challenge handshakes
- Platform allowlists and channel/user policy
- Polling, WebSocket, webhook, IMAP, or bridge event receipt
- File/media download and upload
- Final reply delivery through the platform SDK

The agent runtime owns:

- Workspace and API-token authorization
- Agent model/tool/skill/sandbox resolution
- Conversation and message persistence
- Stable `sessionKey` derivation from source metadata
- Intentional silence handling

## Hosted Hermes Reuse

ToolPlane reuses Hermes platform adapters without copying the whole Hermes
gateway into application code. The Docker image bundles a pinned Hermes checkout
at `/opt/hermes-agent` and a Python virtual environment at
`/opt/toolplane-hermes-venv`; Compose sets the runtime environment so hosted
channel runners can import the selected Hermes adapter and install a message
handler with `adapter.set_message_handler(...)`.

Runtime flow:

```text
Native platform
  -> Hermes adapter
  -> MessageEvent
  -> ToolPlane hosted channel runner
  -> POST /api/v1/agent-channels/:connectionId/events
  -> ToolPlane agent runtime
  -> JSON response { delivery, message }
  -> Hermes adapter send(...)
  -> Native platform
```

This keeps native platform behavior in Hermes:

- Telegram polling/webhook handling, Bot API sending, topics, media batching
- Slack Socket Mode, event dedupe, thread routing, file handling
- Discord Gateway connection, privileged intents, threads, reactions, typing
- WeCom AI Bot WebSocket setup, pairing credentials, heartbeat, reply routing

The platform owns the channel lifecycle, credentials, callback token, runner
process, and agent execution boundary.

Hermes source: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
under the MIT license. If Hermes code is copied instead of dynamically reused,
retain the upstream copyright and license notice.

Current hosted runner starters:

| Platform | Hermes adapter | Required environment |
| --- | --- | --- |
| Telegram | `plugins.platforms.telegram.adapter.TelegramAdapter` | `TOOLPLANE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` |
| Slack | `plugins.platforms.slack.adapter.SlackAdapter` | `TOOLPLANE_API_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USERS` |
| Discord | `plugins.platforms.discord.adapter.DiscordAdapter` | `TOOLPLANE_API_TOKEN`, `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS` |
| WeCom | `plugins.platforms.wecom.adapter.WeComAdapter` | `TOOLPLANE_API_TOKEN`, `WECOM_BOT_ID`, `WECOM_SECRET` |

The published ToolPlane image already contains the pinned Hermes checkout, so
Compose deployments do not need host-specific Hermes paths. The image build
accepts `HERMES_REPO`, `HERMES_REF`, and `HERMES_ARCHIVE_URL` when the bundled
Hermes version needs to be upgraded deliberately. It downloads the pinned source
archive during build instead of installing `git`. The default image installs
the `messaging`, `wecom`, and `dingtalk` extras, which cover the currently
exposed hosted channels: Telegram, Discord, WeCom, Weixin, and DingTalk.
Credentials are entered in the ToolPlane UI and stored encrypted.

For local `pnpm dev` outside Docker, set:

```env
TOOLPLANE_HERMES_ROOT="/absolute/path/to/hermes-agent"
TOOLPLANE_PYTHON="/absolute/path/to/python-or-venv/bin/python"
```

Compose deployments do not need those host-specific paths.

Callback-first platforms such as WhatsApp Cloud, LINE, WeCom Callback, Teams,
and Microsoft Graph do not need a hosted runner. They require
public callback routes, signature verification, and challenge/verify handling
before calling the same ToolPlane handoff endpoint.

## Setup Flow Types

The platform catalog lives in `src/lib/agents/platforms.ts`. Each entry includes
`setupFlow`, credential fields, setup steps, connection mode, and whether a
public callback URL is actually required.

Examples:

| Platform | Flow | First user action | Public callback? |
| --- | --- | --- | --- |
| Telegram | Bot Token | Paste BotFather token and allowed Telegram IDs | No |
| WeCom | QR Scan | Scan WeCom QR; fallback to Bot ID + Secret | No |
| Weixin | QR Scan | Scan WeChat QR for iLink login | No |
| Slack | Socket Mode | Paste `xoxb-` bot token and `xapp-` app token | No |
| Discord | Gateway Bot | Paste bot token and enable privileged intents | No |
| WhatsApp Cloud | Cloud Webhook | Configure Meta app credentials and callback URL | Yes |
| WeCom Callback | Webhook Callback | Create self-built app and encrypted callback | Yes |
| LINE | Webhook Callback | Configure Messaging API channel webhook | Yes |
| SimpleX | Local Daemon | Point platform worker at `simplex-chat` WebSocket daemon | No |
| ntfy | Topic Subscribe | Subscribe platform worker to a topic | No |

## QR And Pairing Flows

Some platforms cannot be configured with a static token form alone:

- Telegram managed bot setup shows a QR deep link; scanning creates the bot,
  but the user must still confirm allowed numeric Telegram user IDs before
  ToolPlane saves the token.
- WeCom AI Bot setup shows a QR code; scanning returns Bot ID and Secret.
- Weixin/iLink login shows a QR code; scanning returns account/session data.
- WhatsApp bridge setup shows a pairing QR that must be scanned in the phone app.
- Signal linking starts with a `signal-cli link` URI that should be rendered as QR.

ToolPlane models these as two-phase channel connections:

```text
create channel -> request QR -> user scans -> poll provider -> save credentials -> stopped -> running
```

Telegram has one extra confirmation step, matching Hermes:

```text
create channel -> request QR -> user scans -> poll ready -> confirm allowed user IDs -> save credentials -> stopped -> running
```

For QR-capable platforms, the UI does not ask users to paste a QR payload.
ToolPlane actively calls the platform setup endpoint, stores the short-lived
pairing session in the channel config, renders the returned QR content, and
polls the platform for scan completion. When the provider returns credentials,
ToolPlane stores them encrypted on the channel.

Current active QR providers:

| Platform | QR request | Poll result | Saved credentials |
| --- | --- | --- | --- |
| Telegram | `setup.hermes-agent.nousresearch.com/v1/telegram/pairings` | managed bot ready + bot token + owner user ID | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` after user confirmation |
| WeCom | `work.weixin.qq.com/ai/qc/generate` | `work.weixin.qq.com/ai/qc/query_result` | `WECOM_BOT_ID`, `WECOM_SECRET` |
| Weixin | `ilink/bot/get_bot_qrcode` | `ilink/bot/get_qrcode_status` | `WEIXIN_ACCOUNT_ID`, `WEIXIN_TOKEN`, `WEIXIN_BASE_URL` |

Bridge platforms such as WhatsApp, Signal, and Yuanbao use the same UI contract,
but still need a ToolPlane setup runner that can start the native bridge,
receive its QR/link event, and report completion back to the channel.
Credentials marked `requiredAt: "start"` are not required when the channel is
first created; they are required before the hosted runner can start.

## Endpoints

Each agent still exposes a generic internal endpoint:

```text
POST /api/v1/agents/:agentId/messages
```

Configured channels use a per-connection endpoint:

```text
POST /api/v1/agent-channels/:connectionId/events
```

This endpoint is generated when the user creates a channel connection in the
agent UI. It is the boundary between native platform handling and the ToolPlane
agent runtime. For example:

- Telegram setup starts with `TELEGRAM_BOT_TOKEN`; the hosted runner then receives
  Telegram updates and calls ToolPlane.
- Slack setup starts with Socket Mode tokens; Slack events arrive over a
  platform-owned WebSocket.
- WeCom setup starts with a QR scan or Bot ID + Secret; the hosted runner uses the
  WeCom AI Bot WebSocket gateway.
- WhatsApp Cloud setup really does need a public HTTPS callback because Meta
  delivers messages by webhook.

Channel handoff endpoints require the generated channel token:

```text
Authorization: Bearer <toolplane-channel-token>
```

For webhook products that cannot send custom authorization headers, the channel
endpoint also accepts a query token:

```text
POST /api/v1/agent-channels/:connectionId/events?token=<toolplane-channel-token>
```

Generic API tokens are for internal services and custom integrations through
`/api/v1/agents/:agentId/messages`. They are not the normal native channel path.

## Normalized Handoff Shape

Hosted runners and callback handlers can send native payloads to the channel
endpoint where ToolPlane has a normalizer, or send the normalized shape directly:

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

## Response Contract

Hosted runners and callback handlers branch on `delivery`.

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

If the final agent response is exactly `[SILENT]`, `SILENT`, `NO_REPLY`, or
`NO REPLY`, ToolPlane returns:

```json
{
  "delivery": "silent",
  "message": "",
  "rawMessage": "NO_REPLY"
}
```

The assistant turn is still persisted in the conversation transcript.

## Supported Platform Slugs

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

Hyphen aliases are also accepted for Hermes-style URLs, such as
`whatsapp-cloud`, `wecom-callback`, `teams-meetings`, `msgraph-webhook`, and
`open-webui`.

## Hermes References

- [Telegram](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram)
- [WeCom](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/wecom)
- [Weixin](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin)
- [Slack](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack)
- [Discord](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord)
- [WhatsApp Cloud](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud)
- [WeCom Callback](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/wecom-callback)
