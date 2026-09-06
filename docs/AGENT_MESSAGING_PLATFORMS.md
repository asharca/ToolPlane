# Agent Messaging Platforms

## Channel Management

The workspace Settings > Channels page (`/app/[workspace]/settings/channels`)
and each Agent's Channels tab use the same platform sidebar, instance rows,
credential editor, connection switch, delete confirmation, and live log dialog.
The interaction reference is Cherry Studio's `ChannelsSettings` feature.
Feishu, Telegram, QQ, WeChat, Discord, and Slack are shown in the same order.

Channels can be created as unbound drafts. Binding an Agent is required before
starting the runner. Deleting an Agent leaves its channel available for rebinding;
deleting a channel stops the runner but preserves conversation history.
Server startup restores bound channels previously marked running or starting;
stopped channels and incomplete drafts remain stopped.
ToolPlane keeps its workspace authorization and Agent sandbox execution model;
it does not embed Cherry Studio's Electron IPC or host-directory access.

Management uses `GET/POST /api/v1/workspaces/[slug]/agent-channels`, with account
Bearer tokens or session cookies. POST actions are `create`, `update`, `delete`,
`start`, `stop`, `pair`, `check`, `apply`, and `move`. `GET ?logs=[connectionId]` returns
the last 200 in-memory log lines after workspace authorization. Known secrets
are redacted, and no management response includes runner or inbound tokens.
Non-secret configuration values can be read and cleared. Empty secret fields
preserve the encrypted stored value. Editing a running connection restarts it.

Channel sessions are keyed by connection ID as well as the upstream chat, so
two bots bound to the same Agent cannot share history accidentally. `/whoami`
returns upstream IDs and `/new` starts a new conversation. User/chat allowlists
are checked before Agent execution, including at the HTTP handoff boundary.

Channel conversations appear under their Agent in the Work sidebar's Channels
group. They remain ordinary `Conversation`/`Message` history, not Work sessions.
Selecting a conversation uses `/app/[workspace]/work?agent=[agentId]&c=[conversationId]`
inside the existing Work surface, preserving its sidebar, search, and sandbox tools.
`/app/[workspace]/chat` is reserved for assistants; legacy Agent chat routes redirect
to Work. Channel history remains read-only in the console and refreshes every five
seconds. Migration leaves earlier history with its original Agent.

Feishu/Lark registration uses the QR device flow and automatically saves the
returned App ID and App Secret. WeChat uses the existing iLink pairing flow.
Polling stops on completion, expiration, failure, or closing the editor.
Primary credential fields follow the reference; additional ToolPlane policies
and manual WeChat credentials remain under Advanced.

Platform onboarding is not one universal URL. Each ecosystem has its own setup
surface: a bot token form, a Socket Mode app, a QR scan, a local daemon, an
email inbox, or a public webhook callback.

The ToolPlane platform owns native channel work and agent execution. A channel
connection belongs to one agent and represents one configured external
ecosystem entry point.

## Conversation Operations

Channels support `/new`, `/help`, `/whoami`, and their Agent runtime's commands. Commands are
ordered with incoming messages for the same chat. `/new` switches subsequent
messages to a new conversation without deleting the previous history; `/help`
and `/whoami` do not add model context.
The channel configuration dialog lists these commands. `/new` is channel-only;
the Work composer uses the **New task** action instead.

The existing Agent Work header also provides Compact context and New channel
conversation controls. Normal Work chats retain their own New work control.
Operations never send console text as a channel message or move the user into
the assistant interface.

The Work composer shares one six-item menu between `+` and `/`: attachments,
saved prompt management, MCP prompts, MCP resources, user-invocable attached
skills, and New task. Its placeholder explains `/` and `@`. `@` searches files
and conversations in the current sandbox, including its channel histories;
the current conversation is excluded. Reference reads verify workspace, Agent,
and sandbox ownership. Selected references are removable chips, are persisted
as text parts with reference metadata, and are included in runtime context.
Prompt templates are stored per Agent, not in browser storage.
The menu's **Customize toolbar** entry pins/unpins actions, supports drag or
button reordering, and restores defaults. Pinned actions leave the root menu;
toolbar preferences persist in this browser across Work sessions.

Following Cherry, `/` also lists runtime commands (not extra `+` tools): Pi
provides `/compact [focus]`; Claude Code provides `/clear`, `/compact [focus]`,
`/context`, `/usage`; DSH provides `/compact` and `/goal` with its native
objective/edit/pause/resume/clear arguments. The live Claude/DSH command registry
can add third-party commands for that session. Selection inserts the command;
submission executes it. Unsupported commands never become ordinary model prompts.

Commands run through the native runtime, not host-side imitations. Work commands
use the same coordinator and runtime configuration as normal turns. Claude Code
and Pi retain their CLI session between turns over a sandbox-local Unix socket;
idle processes stop after two minutes and subsequent turns resume native session
files. DSH resumes its native persisted session and command registry. Each
ToolPlane conversation has a separate native session. Compaction changes that
native session's active context, and `/new` starts a separate session. Existing
platform history is imported only on first use, not replayed over native
compaction. Claude `/usage` returns native output appropriate to its authentication
mode, never a platform-estimated statistics panel. Command output is stored and
rendered as an ordinary assistant reply with copy support, including legacy
command records; control readouts are excluded from model context.

For Hermes, compaction keeps recent
exchanges verbatim and saves a system message containing a
`data-conversation-compaction` part. Original messages and attachments remain
unchanged. Work, console chat, and channel turns project the latest summary plus
messages after its boundary into the runtime; full history is still displayed.
Hermes receives a fresh runtime session alias and the retained context seed.
Failed, cancelled, busy, or non-shrinking compactions leave the history unchanged.
The displayed token reduction is an estimate. Compaction and new-session actions
use the same workspace/Agent authorization and per-conversation admission gate
as incoming turns. No Hermes platform adapter is involved.

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

## Native Transports

Channel adapters are adapted from Cherry Studio's Node channel implementations
at revision c03519c028cfe25e32060ad7dcdeea531f22fd46. See
`src/lib/agents/channels/NOTICE` and the retained AGPL license. Electron IPC,
host-directory credential storage, and Cherry's Agent executor are not included.

| Platform | Native transport | Credentials |
| --- | --- | --- |
| Telegram | grammY Bot API polling | Bot token |
| Feishu / Lark | Official Lark Node SDK WebSocket | App ID and secret |
| QQ | Official bot REST API and WebSocket gateway | App ID and secret |
| WeChat | Tencent iLink polling and encrypted media | QR-issued token and account ID |
| Discord | REST API and Gateway WebSocket | Bot token |
| Slack | REST API and Socket Mode | Bot and app tokens |

`channel-runtime.ts` manages these adapters in the long-lived Node server.
Inbound messages call `runAgentChannelMessage` directly, then replies use the
same adapter. There is no Python process, Hermes platform import, or Hermes
checkout path. DSH, Pi, Claude Code, and Hermes Agent runtimes keep their own
execution paths; channel transport never chooses an Agent runtime.

WeCom and DingTalk's legacy records are retained, but their old Hermes-based
hosted starters are not available. They are not offered as new native channels.
Callback integrations remain separate and must authenticate their handoff.

## Sandbox Ownership And Migration

Each sandbox has a Channels tab. `AgentChannelConnection.sandboxId` scopes its
configuration; the bound Agent is resolved from that sandbox's assignment.
Existing Agent channels are backfilled to the Agent's runtime/default sandbox.
Unassigned sandboxes accept draft configurations but cannot start replies until
an Agent is assigned. Managed public-endpoint sandboxes are excluded.

The workspace list remains available for managing all channels, including
unassigned drafts. `GET ?sandboxId=...` returns only that sandbox's channels.
`POST { action: "move", connectionId, sandboxId }` moves a channel to another
sandbox in the same workspace. It stops the old adapter and aborts in-flight
turns before rebinding. Credentials, pairing state, connection ID, and inbound
token stay unchanged, so migration does not require another QR scan. An active
channel restarts against the target Agent. A target without an Agent receives
a stopped draft. A failed restart rolls back the original binding.

History remains with its original Agent; the target Agent starts its own
conversation. A caller cannot reuse the original Agent's conversation ID.
Queued old messages and late adapter events cannot reply after a move.
Runtime turns explicitly receive the channel's sandbox ID, including DSH.

Server recovery and adapter state are single-process. Queue depth is limited to
20 pending messages per channel; logs retain the last 200 lines in memory.
Use a durable queue and distributed ownership before running multiple app
replicas against the same bot credentials.

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
- WeChat setup starts with a QR scan; the native transport long-polls iLink.
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
