import type { AgentMessageBody } from '@/lib/agents/chat-body';

export type MessagingPlatformSlug =
  | 'api'
  | 'webhooks'
  | 'open_webui'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'google_chat'
  | 'whatsapp'
  | 'whatsapp_cloud'
  | 'signal'
  | 'sms'
  | 'email'
  | 'homeassistant'
  | 'mattermost'
  | 'matrix'
  | 'dingtalk'
  | 'feishu'
  | 'wecom'
  | 'wecom_callback'
  | 'weixin'
  | 'bluebubbles'
  | 'qqbot'
  | 'yuanbao'
  | 'teams'
  | 'teams_meetings'
  | 'msgraph_webhook'
  | 'line'
  | 'ntfy'
  | 'raft'
  | 'irc'
  | 'simplex'
  | 'photon';

export type MessagingPlatformKind = 'http' | 'webhook' | 'bot' | 'bridge' | 'email';

export type MessagingSetupFlow =
  | 'direct_api'
  | 'openai_compatible'
  | 'bot_token'
  | 'socket_mode'
  | 'gateway_bot'
  | 'qr_scan'
  | 'webhook_callback'
  | 'cloud_webhook'
  | 'bridge_pairing'
  | 'daemon'
  | 'email_sync'
  | 'topic'
  | 'platform_app';

export type MessagingCredential = {
  name: string;
  label: string;
  required?: boolean;
  requiredAt?: 'create' | 'start';
  secret?: boolean;
  placeholder?: string;
  help?: string;
  multiline?: boolean;
};

export type MessagingPairing = {
  type: 'qr';
  provider:
    | 'telegram_managed_bot'
    | 'wecom_admin_qr'
    | 'weixin_ilink_qr'
    | 'dingtalk_device_qr'
    | 'external_setup_runner';
  label: string;
  description: string;
  scanTarget: string;
  completion: string;
  requestLabel?: string;
  checkLabel?: string;
};

export type MessagingPlatform = {
  slug: MessagingPlatformSlug;
  label: string;
  kind: MessagingPlatformKind;
  summary: string;
  requiredEnv: string[];
  setupFlow: MessagingSetupFlow;
  primaryAction: string;
  connectionMode: string;
  publicEndpointRequired: boolean;
  credentials: MessagingCredential[];
  setupSteps: string[];
  pairing?: MessagingPairing;
  operatorNotes?: string[];
  docsUrl?: string;
  capabilities: {
    voice?: boolean;
    images?: boolean;
    files?: boolean;
    threads?: boolean;
    reactions?: boolean;
    typing?: boolean;
    streaming?: boolean;
  };
};

export function hasBuiltInPairingProvider(platform: MessagingPlatform) {
  return Boolean(platform.pairing && platform.pairing.provider !== 'external_setup_runner');
}

export const MESSAGING_PLATFORMS: MessagingPlatform[] = [
  {
    slug: 'api',
    label: 'API Server',
    kind: 'http',
    summary: 'OpenAI-compatible frontends or internal services call ToolPlane over HTTP.',
    requiredEnv: ['TOOLPLANE_API_TOKEN'],
    setupFlow: 'direct_api',
    primaryAction: 'Create an API token',
    connectionMode: 'Direct HTTP request to the agent gateway.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'TOOLPLANE_API_TOKEN', label: 'ToolPlane API token', required: true, secret: true },
    ],
    setupSteps: [
      'Create a dedicated ToolPlane API token for this caller.',
      'Send normalized message payloads to the generic agent endpoint.',
      'Store the returned conversationId when the caller wants a durable thread.',
    ],
    capabilities: { threads: true, streaming: true },
  },
  {
    slug: 'webhooks',
    label: 'Webhooks',
    kind: 'webhook',
    summary: 'Generic inbound webhook receiver for custom apps and automation systems.',
    requiredEnv: ['TOOLPLANE_API_TOKEN', 'WEBHOOK_HMAC_SECRET'],
    setupFlow: 'webhook_callback',
    primaryAction: 'Create a signed webhook route',
    connectionMode: 'External services POST events to a ToolPlane URL.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'TOOLPLANE_API_TOKEN', label: 'ToolPlane API token', required: true, secret: true },
      { name: 'WEBHOOK_HMAC_SECRET', label: 'Webhook signing secret', secret: true, placeholder: 'optional but recommended' },
    ],
    setupSteps: [
      'Create a per-webhook API token and optional HMAC secret.',
      'Configure the upstream app to POST JSON to the webhook endpoint.',
      'Map the upstream sender and channel into source.userId and source.chatId.',
    ],
    operatorNotes: ['This is the generic escape hatch, not the right first step for native chat platforms that support bot tokens, gateways, or QR pairing.'],
    capabilities: { images: true, files: true, threads: true },
  },
  {
    slug: 'open_webui',
    label: 'Open WebUI',
    kind: 'http',
    summary: 'Open WebUI or OpenAI-compatible chat surfaces forward user turns.',
    requiredEnv: ['TOOLPLANE_API_TOKEN'],
    setupFlow: 'openai_compatible',
    primaryAction: 'Register ToolPlane as a model endpoint',
    connectionMode: 'OpenAI-compatible HTTP client calls ToolPlane.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'TOOLPLANE_API_TOKEN', label: 'ToolPlane API token', required: true, secret: true },
      { name: 'OPEN_WEBUI_BASE_URL', label: 'ToolPlane base URL', placeholder: 'http://localhost:3002/api/v1' },
    ],
    setupSteps: [
      'Create an API token for Open WebUI.',
      'Add ToolPlane as an OpenAI-compatible provider or function pipeline.',
      'Route selected conversations to the target agent.',
    ],
    capabilities: { images: true, files: true, threads: true, streaming: true },
  },
  {
    slug: 'telegram',
    label: 'Telegram',
    kind: 'bot',
    summary: 'Telegram Bot API updates, private chats, groups, and topics.',
    requiredEnv: ['TELEGRAM_BOT_TOKEN'],
    setupFlow: 'bot_token',
    primaryAction: 'Set up with QR or save BotFather token',
    connectionMode: 'Hosted runner uses Telegram Bot API polling or webhook delivery.',
    publicEndpointRequired: false,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram',
    credentials: [
      { name: 'TELEGRAM_BOT_TOKEN', label: 'Bot token from @BotFather', required: true, requiredAt: 'start', secret: true, placeholder: 'auto-filled by QR or 123456789:ABCdef...' },
      { name: 'TELEGRAM_ALLOWED_USERS', label: 'Allowed Telegram user IDs', placeholder: 'blank means everyone', help: 'Optional numeric Telegram IDs. Leave blank to allow everyone.' },
      { name: 'TELEGRAM_ALLOWED_CHATS', label: 'Allowed group or topic IDs', placeholder: '-1001234567890' },
      { name: 'TELEGRAM_ALLOW_ALL_USERS', label: 'Allow all users', placeholder: 'defaults to true when allowed users is blank' },
    ],
    pairing: {
      type: 'qr',
      provider: 'telegram_managed_bot',
      label: 'Telegram managed bot QR',
      description: 'ToolPlane starts the Hermes managed-bot flow, displays the Telegram deep-link QR, then waits for Telegram to return the bot token.',
      scanTarget: 'Telegram mobile app',
      completion: 'After Telegram reports the bot is ready, confirm the allowed numeric user IDs before saving.',
      requestLabel: 'Set up with QR',
      checkLabel: 'Check Telegram setup',
    },
    setupSteps: [
      'Start QR setup or create a Telegram bot manually in @BotFather.',
      'Scan the QR to open Telegram and confirm the managed bot creation.',
      'When ToolPlane detects the bot token, optionally restrict allowed numeric Telegram user IDs.',
      'Start the Telegram hosted runner so it can receive updates and deliver replies.',
    ],
    operatorNotes: ['ToolPlane defaults Telegram to allow everyone when no allowlist is configured.'],
    capabilities: { voice: true, images: true, files: true, threads: true, typing: true, streaming: true },
  },
  {
    slug: 'discord',
    label: 'Discord',
    kind: 'bot',
    summary: 'Discord bot messages, threads, reactions, and channel routing.',
    requiredEnv: ['DISCORD_BOT_TOKEN'],
    setupFlow: 'gateway_bot',
    primaryAction: 'Save Discord bot token',
    connectionMode: 'Discord Gateway WebSocket bot connection.',
    publicEndpointRequired: false,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord',
    credentials: [
      { name: 'DISCORD_BOT_TOKEN', label: 'Bot token', required: true, secret: true },
      { name: 'DISCORD_ALLOWED_USERS', label: 'Allowed Discord user IDs', placeholder: '284102345871466496' },
      { name: 'DISCORD_ALLOWED_ROLES', label: 'Allowed role IDs', placeholder: 'optional role allowlist' },
      { name: 'DISCORD_ALLOW_ALL_USERS', label: 'Allow all users', placeholder: 'true or false' },
      { name: 'DISCORD_HOME_CHANNEL', label: 'Home channel ID', placeholder: 'optional default channel' },
    ],
    setupSteps: [
      'Create a Discord application and bot in the Developer Portal.',
      'Enable Message Content Intent and Server Members Intent.',
      'Invite the bot with bot and applications.commands scopes.',
      'Save the bot token plus user or role allowlists, then start the hosted runner.',
    ],
    operatorNotes: ['If Message Content Intent is off, the bot can connect but message text will be empty.'],
    capabilities: { voice: true, images: true, files: true, threads: true, reactions: true, typing: true, streaming: true },
  },
  {
    slug: 'slack',
    label: 'Slack',
    kind: 'bot',
    summary: 'Slack Events API, slash commands, channels, DMs, and threads.',
    requiredEnv: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_ALLOWED_USERS'],
    setupFlow: 'socket_mode',
    primaryAction: 'Save Socket Mode tokens',
    connectionMode: 'Slack Socket Mode WebSocket; no public Events URL required.',
    publicEndpointRequired: false,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack',
    credentials: [
      { name: 'SLACK_BOT_TOKEN', label: 'Bot User OAuth Token', required: true, secret: true, placeholder: 'xoxb-...' },
      { name: 'SLACK_APP_TOKEN', label: 'App-Level Token', required: true, secret: true, placeholder: 'xapp-...' },
      { name: 'SLACK_ALLOWED_USERS', label: 'Allowed Slack member IDs', required: true, placeholder: 'U01ABC2DEF3' },
    ],
    setupSteps: [
      'Create a Slack app, preferably from a generated manifest.',
      'Enable Socket Mode and generate an app-level xapp token with connections:write.',
      'Install the app to the workspace and copy the xoxb bot token.',
      'Subscribe to message events and enable the App Home messages tab.',
      'Invite the bot to channels where it should respond.',
    ],
    operatorNotes: ['Slack Socket Mode replaces public Events API URLs for this flow.'],
    capabilities: { voice: true, images: true, files: true, threads: true, reactions: true, typing: true, streaming: true },
  },
  {
    slug: 'google_chat',
    label: 'Google Chat',
    kind: 'webhook',
    summary: 'Google Chat spaces, DMs, and card/webhook events.',
    requiredEnv: ['GOOGLE_CHAT_CREDENTIALS'],
    setupFlow: 'platform_app',
    primaryAction: 'Create Google Chat app',
    connectionMode: 'Google Chat app callback or Pub/Sub adapter.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'GOOGLE_CHAT_CREDENTIALS', label: 'Google service credentials', required: true, secret: true },
      { name: 'GOOGLE_CHAT_ALLOWED_USERS', label: 'Allowed Google user IDs', placeholder: 'optional allowlist' },
    ],
    setupSteps: [
      'Create and configure a Google Chat app in Google Cloud.',
      'Choose HTTP callback or Pub/Sub delivery.',
      'Verify Google signatures in the platform worker before forwarding events.',
    ],
    capabilities: { images: true, files: true, threads: true, typing: true },
  },
  {
    slug: 'whatsapp',
    label: 'WhatsApp',
    kind: 'bridge',
    summary: 'WhatsApp bridge messages and media delivery.',
    requiredEnv: ['WHATSAPP_ALLOWED_USERS'],
    setupFlow: 'bridge_pairing',
    primaryAction: 'Pair WhatsApp bridge',
    connectionMode: 'Unofficial bridge session paired from the phone app.',
    publicEndpointRequired: false,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp',
    credentials: [
      { name: 'WHATSAPP_ALLOWED_USERS', label: 'Allowed WhatsApp IDs', required: true },
      { name: 'WHATSAPP_SESSION_PATH', label: 'Bridge session path', placeholder: '~/.toolplane/whatsapp' },
    ],
    pairing: {
      type: 'qr',
      provider: 'external_setup_runner',
      label: 'WhatsApp pairing QR',
      description: 'ToolPlane starts the configured WhatsApp bridge setup runner and displays the returned pairing QR.',
      scanTarget: 'WhatsApp mobile app',
      completion: 'After scan, keep the bridge session path and allowed sender IDs in this channel.',
      requestLabel: 'Request WhatsApp QR',
    },
    setupSteps: [
      'Start the WhatsApp bridge worker.',
      'Scan the pairing QR code from the WhatsApp mobile app.',
      'Record allowed sender IDs and keep the bridge session running.',
    ],
    operatorNotes: ['Use WhatsApp Cloud for production business bots; bridge pairing is unofficial and account-risky.'],
    capabilities: { images: true, files: true, streaming: true },
  },
  {
    slug: 'whatsapp_cloud',
    label: 'WhatsApp Cloud',
    kind: 'webhook',
    summary: 'Meta WhatsApp Cloud API webhooks.',
    requiredEnv: ['WHATSAPP_CLOUD_PHONE_NUMBER_ID', 'WHATSAPP_CLOUD_ACCESS_TOKEN', 'WHATSAPP_CLOUD_APP_SECRET', 'WHATSAPP_CLOUD_VERIFY_TOKEN'],
    setupFlow: 'cloud_webhook',
    primaryAction: 'Configure Meta webhook',
    connectionMode: 'Meta Cloud API POSTs signed webhook events to a public HTTPS URL.',
    publicEndpointRequired: true,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud',
    credentials: [
      { name: 'WHATSAPP_CLOUD_PHONE_NUMBER_ID', label: 'Phone Number ID', required: true, placeholder: '15-17 digit ID, not the phone number' },
      { name: 'WHATSAPP_CLOUD_ACCESS_TOKEN', label: 'Access token', required: true, secret: true, placeholder: 'EAA...' },
      { name: 'WHATSAPP_CLOUD_APP_SECRET', label: 'App secret', required: true, secret: true },
      { name: 'WHATSAPP_CLOUD_VERIFY_TOKEN', label: 'Verify token', required: true, secret: true },
      { name: 'WHATSAPP_CLOUD_ALLOWED_USERS', label: 'Allowed wa_ids', placeholder: '15551234567' },
    ],
    setupSteps: [
      'Create a Meta app with WhatsApp enabled and copy the Phone Number ID.',
      'Create a long-lived access token for production.',
      'Expose the channel webhook through HTTPS.',
      'Paste the callback URL and verify token into Meta, then subscribe to messages.',
    ],
    operatorNotes: ['This is one of the few flows where a public HTTPS callback URL is truly the central setup step.'],
    capabilities: { images: true, files: true },
  },
  {
    slug: 'signal',
    label: 'Signal',
    kind: 'bridge',
    summary: 'Signal bridge messages and attachments.',
    requiredEnv: ['SIGNAL_ALLOWED_USERS'],
    setupFlow: 'daemon',
    primaryAction: 'Link signal-cli daemon',
    connectionMode: 'Local signal-cli daemon or bridge receives messages.',
    publicEndpointRequired: false,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/signal',
    credentials: [
      { name: 'SIGNAL_ALLOWED_USERS', label: 'Allowed Signal numbers or UUIDs', required: true },
      { name: 'SIGNAL_HTTP_URL', label: 'signal-cli REST URL', required: true, placeholder: 'http://127.0.0.1:8080' },
      { name: 'SIGNAL_ACCOUNT', label: 'Signal account number or UUID', placeholder: '+15551234567' },
    ],
    pairing: {
      type: 'qr',
      provider: 'external_setup_runner',
      label: 'Signal link QR',
      description: 'ToolPlane starts the configured signal-cli linking runner and displays the returned link QR.',
      scanTarget: 'Signal mobile app',
      completion: 'Run signal-cli REST after linking, then save the REST URL and allowed users.',
      requestLabel: 'Request Signal QR',
    },
    setupSteps: [
      'Install signal-cli and link the account by QR code or linking URI.',
      'Run the signal-cli daemon.',
      'Configure allowed users or groups and start the hosted runner.',
    ],
    capabilities: { images: true, files: true, streaming: true },
  },
  {
    slug: 'sms',
    label: 'SMS',
    kind: 'webhook',
    summary: 'SMS providers such as Twilio or webhook-based phone relays.',
    requiredEnv: ['SMS_ALLOWED_USERS'],
    setupFlow: 'webhook_callback',
    primaryAction: 'Configure SMS provider callback',
    connectionMode: 'Provider webhook sends inbound SMS events.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'SMS_ALLOWED_USERS', label: 'Allowed phone numbers', required: true },
      { name: 'SMS_PROVIDER_AUTH_TOKEN', label: 'Provider auth token', secret: true },
    ],
    setupSteps: [
      'Buy or attach a phone number in the SMS provider.',
      'Configure inbound SMS callback URL.',
      'Verify the provider signature in the platform worker.',
    ],
    capabilities: {},
  },
  {
    slug: 'email',
    label: 'Email',
    kind: 'email',
    summary: 'Inbound email, replies, and attachment-aware workflows.',
    requiredEnv: ['EMAIL_ALLOWED_USERS'],
    setupFlow: 'email_sync',
    primaryAction: 'Connect mailbox',
    connectionMode: 'IMAP/SMTP sync or inbound-mail provider webhook.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'EMAIL_ALLOWED_USERS', label: 'Allowed sender addresses', required: true, placeholder: 'alice@example.com' },
      { name: 'EMAIL_IMAP_URL', label: 'IMAP URL', placeholder: 'imaps://imap.example.com' },
      { name: 'EMAIL_SMTP_URL', label: 'SMTP URL', placeholder: 'smtps://smtp.example.com' },
      { name: 'EMAIL_PASSWORD', label: 'Mailbox password or app password', secret: true },
    ],
    setupSteps: [
      'Create a mailbox or provider route for the agent.',
      'Configure IMAP for inbound mail and SMTP for replies, or use an inbound provider webhook.',
      'Restrict senders before letting the agent process mail.',
    ],
    capabilities: { images: true, files: true, threads: true },
  },
  {
    slug: 'homeassistant',
    label: 'Home Assistant',
    kind: 'webhook',
    summary: 'Home Assistant automations and assistant events.',
    requiredEnv: ['HOMEASSISTANT_TOKEN'],
    setupFlow: 'webhook_callback',
    primaryAction: 'Create Home Assistant automation',
    connectionMode: 'Local automation sends events to ToolPlane over HTTP.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'HOMEASSISTANT_TOKEN', label: 'Home Assistant long-lived token', secret: true },
      { name: 'HOMEASSISTANT_ALLOWED_USERS', label: 'Allowed user IDs', placeholder: 'optional allowlist' },
    ],
    setupSteps: [
      'Create a Home Assistant automation or webhook trigger.',
      'Call the ToolPlane agent gateway from the automation action.',
      'Map the Home Assistant context into source metadata.',
    ],
    capabilities: {},
  },
  {
    slug: 'mattermost',
    label: 'Mattermost',
    kind: 'bot',
    summary: 'Mattermost bot posts, channels, files, and threads.',
    requiredEnv: ['MATTERMOST_TOKEN', 'MATTERMOST_ALLOWED_USERS'],
    setupFlow: 'gateway_bot',
    primaryAction: 'Save Mattermost bot token',
    connectionMode: 'Mattermost bot connection plus REST/WebSocket events.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'MATTERMOST_TOKEN', label: 'Bot access token', required: true, secret: true },
      { name: 'MATTERMOST_URL', label: 'Mattermost server URL', required: true, placeholder: 'https://mattermost.example.com' },
      { name: 'MATTERMOST_ALLOWED_USERS', label: 'Allowed user IDs', required: true },
    ],
    setupSteps: [
      'Create a Mattermost bot account and token.',
      'Invite the bot to the channels it should serve.',
      'Start the hosted runner so it can receive posts and deliver replies.',
    ],
    capabilities: { voice: true, images: true, files: true, threads: true, typing: true, streaming: true },
  },
  {
    slug: 'matrix',
    label: 'Matrix',
    kind: 'bridge',
    summary: 'Matrix rooms, DMs, reactions, media, and threads.',
    requiredEnv: ['MATRIX_ACCESS_TOKEN', 'MATRIX_ALLOWED_USERS'],
    setupFlow: 'gateway_bot',
    primaryAction: 'Save Matrix access token',
    connectionMode: 'Matrix bot account syncs rooms through the homeserver.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'MATRIX_HOMESERVER', label: 'Homeserver URL', required: true, placeholder: 'https://matrix.org' },
      { name: 'MATRIX_ACCESS_TOKEN', label: 'Access token', required: true, secret: true },
      { name: 'MATRIX_ALLOWED_USERS', label: 'Allowed Matrix IDs', required: true, placeholder: '@alice:matrix.org' },
    ],
    setupSteps: [
      'Create or choose a Matrix account for the agent.',
      'Generate an access token for that account.',
      'Invite the account to rooms and start the hosted runner sync loop.',
    ],
    capabilities: { voice: true, images: true, files: true, threads: true, reactions: true, typing: true, streaming: true },
  },
  {
    slug: 'dingtalk',
    label: 'DingTalk',
    kind: 'bot',
    summary: 'DingTalk Stream Mode messages, files, mentions, and enterprise chats.',
    requiredEnv: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
    setupFlow: 'qr_scan',
    primaryAction: 'Scan DingTalk authorization QR',
    connectionMode: 'DingTalk Stream Mode WebSocket; no public callback URL.',
    publicEndpointRequired: false,
    docsUrl: 'https://open.dingtalk.com/document/orgapp/the-robot-development-process',
    credentials: [
      { name: 'DINGTALK_CLIENT_ID', label: 'Client ID / app key', required: true, requiredAt: 'start', placeholder: 'auto-filled by QR or paste app key' },
      { name: 'DINGTALK_CLIENT_SECRET', label: 'Client secret / app secret', required: true, requiredAt: 'start', secret: true, placeholder: 'auto-filled by QR or paste app secret' },
      { name: 'DINGTALK_ALLOWED_USERS', label: 'Allowed staff or sender IDs', placeholder: 'manager1234,*' },
      { name: 'DINGTALK_HOME_CHANNEL', label: 'Home channel ID', placeholder: 'optional conversation ID' },
      { name: 'DINGTALK_HOME_CHANNEL_NAME', label: 'Home channel name', placeholder: 'optional display name' },
      { name: 'DINGTALK_REQUIRE_MENTION', label: 'Require mention', placeholder: 'true or false' },
      { name: 'DINGTALK_FREE_RESPONSE_CHATS', label: 'Free-response chat IDs', placeholder: 'cidABC==,cidDEF==' },
      { name: 'DINGTALK_ALLOWED_CHATS', label: 'Allowed chat IDs', placeholder: 'cidABC==,cidDEF==' },
      { name: 'DINGTALK_WEBHOOK_URL', label: 'Robot webhook URL', placeholder: 'optional send-only webhook' },
    ],
    pairing: {
      type: 'qr',
      provider: 'dingtalk_device_qr',
      label: 'DingTalk authorization QR',
      description: 'ToolPlane starts the same DingTalk device authorization flow used by Hermes and stores the returned Client ID and Client Secret.',
      scanTarget: 'DingTalk mobile app',
      completion: 'After authorization succeeds, Client ID and Client Secret are saved on this channel automatically.',
      requestLabel: 'Request DingTalk QR',
      checkLabel: 'Check DingTalk scan',
    },
    setupSteps: [
      'Choose QR setup, or paste Client ID and Client Secret from the DingTalk developer console.',
      'Scan the authorization QR with the DingTalk mobile app.',
      'ToolPlane polls DingTalk until Client ID and Client Secret are returned.',
      'Optionally restrict allowed staff IDs or chat IDs before starting the runner.',
    ],
    operatorNotes: ['This follows Hermes Stream Mode, not a public webhook callback. The QR page may be branded OpenClaw because DingTalk exposes that registration bridge.'],
    capabilities: { images: true, files: true, reactions: true, streaming: true },
  },
  {
    slug: 'feishu',
    label: 'Feishu / Lark',
    kind: 'webhook',
    summary: 'Feishu/Lark bot events, comments, meetings, and threads.',
    requiredEnv: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ALLOWED_USERS'],
    setupFlow: 'webhook_callback',
    primaryAction: 'Create Feishu/Lark bot app',
    connectionMode: 'Feishu event subscription callback or stream worker.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'FEISHU_APP_ID', label: 'App ID', required: true },
      { name: 'FEISHU_APP_SECRET', label: 'App secret', required: true, secret: true },
      { name: 'FEISHU_VERIFICATION_TOKEN', label: 'Verification token', secret: true },
      { name: 'FEISHU_ALLOWED_USERS', label: 'Allowed user IDs', required: true },
    ],
    setupSteps: [
      'Create an internal Feishu/Lark app and bot.',
      'Subscribe to message events and configure callback verification.',
      'Publish or install the app to the tenant, then start the hosted runner.',
    ],
    capabilities: { voice: true, images: true, files: true, threads: true, reactions: true, typing: true, streaming: true },
  },
  {
    slug: 'wecom',
    label: 'WeCom',
    kind: 'bot',
    summary: 'WeCom app messages and enterprise chat events.',
    requiredEnv: ['WECOM_BOT_ID', 'WECOM_SECRET'],
    setupFlow: 'qr_scan',
    primaryAction: 'Start QR scan setup',
    connectionMode: 'WeCom AI Bot WebSocket gateway; no public callback URL.',
    publicEndpointRequired: false,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/wecom',
    credentials: [
      { name: 'WECOM_BOT_ID', label: 'AI Bot ID', required: true, requiredAt: 'start', placeholder: 'auto-filled by QR scan' },
      { name: 'WECOM_SECRET', label: 'AI Bot Secret', required: true, requiredAt: 'start', secret: true, placeholder: 'auto-filled by QR scan' },
      { name: 'WECOM_ALLOWED_USERS', label: 'Allowed WeCom users', placeholder: 'optional allowlist' },
      { name: 'WECOM_HOME_CHANNEL', label: 'Home channel', placeholder: 'optional chat ID' },
      { name: 'WECOM_WEBSOCKET_URL', label: 'WebSocket gateway URL', placeholder: 'wss://openws.work.weixin.qq.com' },
      { name: 'WECOM_DM_POLICY', label: 'DM policy', placeholder: 'open, allowlist, disabled, or pairing' },
      { name: 'WECOM_GROUP_POLICY', label: 'Group policy', placeholder: 'open, allowlist, or disabled' },
      { name: 'WECOM_GROUP_ALLOW_FROM', label: 'Allowed group IDs', placeholder: 'group_id_1,group_id_2' },
      { name: 'WECOM_GROUPS_JSON', label: 'Per-group allowlist JSON', placeholder: '{\"group_id\":{\"allow_from\":[\"user_id\"]}}', multiline: true },
    ],
    pairing: {
      type: 'qr',
      provider: 'wecom_admin_qr',
      label: 'WeCom setup QR',
      description: 'ToolPlane requests a WeCom admin-console setup QR and polls WeCom for Bot ID and Secret after scan.',
      scanTarget: 'WeCom mobile app',
      completion: 'After the scan returns Bot ID and Secret, save them on this channel before starting the runner.',
      requestLabel: 'Request WeCom QR',
      checkLabel: 'Check WeCom scan',
    },
    setupSteps: [
      'Launch the platform worker setup and choose WeCom.',
      'Request the setup QR from ToolPlane and scan it with the WeCom mobile app.',
      'Let the setup retrieve Bot ID and Secret automatically.',
      'If scan-to-create is unavailable, paste Bot ID and Secret from the WeCom Admin Console.',
    ],
    operatorNotes: ['This is not the callback integration. WeCom Bot uses a persistent WebSocket connection and supports DM/group access policies.'],
    capabilities: { voice: true, images: true, files: true },
  },
  {
    slug: 'wecom_callback',
    label: 'WeCom Callback',
    kind: 'webhook',
    summary: 'WeCom callback-only integration.',
    requiredEnv: ['WECOM_CALLBACK_CORP_ID', 'WECOM_CALLBACK_CORP_SECRET', 'WECOM_CALLBACK_AGENT_ID', 'WECOM_CALLBACK_TOKEN', 'WECOM_CALLBACK_ENCODING_AES_KEY'],
    setupFlow: 'webhook_callback',
    primaryAction: 'Configure WeCom self-built app callback',
    connectionMode: 'WeCom pushes encrypted XML callbacks to a public HTTPS URL.',
    publicEndpointRequired: true,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/wecom-callback',
    credentials: [
      { name: 'WECOM_CALLBACK_CORP_ID', label: 'Corp ID', required: true },
      { name: 'WECOM_CALLBACK_CORP_SECRET', label: 'Corp secret', required: true, secret: true },
      { name: 'WECOM_CALLBACK_AGENT_ID', label: 'Agent ID', required: true },
      { name: 'WECOM_CALLBACK_TOKEN', label: 'Callback token', required: true, secret: true },
      { name: 'WECOM_CALLBACK_ENCODING_AES_KEY', label: 'EncodingAESKey', required: true, secret: true },
    ],
    setupSteps: [
      'Create a self-built app in the WeCom Admin Console.',
      'Copy Corp ID, Corp Secret, Agent ID, Token, and EncodingAESKey.',
      'Expose the callback listener through HTTPS and paste the callback URL in WeCom.',
      'Verify the callback handshake, then process encrypted POST messages.',
    ],
    capabilities: {},
  },
  {
    slug: 'weixin',
    label: 'Weixin',
    kind: 'bridge',
    summary: 'Weixin bridge events, files, images, and voice.',
    requiredEnv: ['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID'],
    setupFlow: 'qr_scan',
    primaryAction: 'Scan WeChat QR login',
    connectionMode: 'Tencent iLink long-polling; no public endpoint or webhook.',
    publicEndpointRequired: false,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin',
    credentials: [
      { name: 'WEIXIN_ACCOUNT_ID', label: 'iLink account ID', required: true, requiredAt: 'start', placeholder: 'saved after QR login' },
      { name: 'WEIXIN_TOKEN', label: 'iLink token', required: true, requiredAt: 'start', secret: true, placeholder: 'usually saved by setup' },
      { name: 'WEIXIN_BASE_URL', label: 'iLink base URL', placeholder: 'usually saved by setup' },
      { name: 'WEIXIN_CDN_BASE_URL', label: 'iLink CDN base URL', placeholder: 'optional CDN override' },
      { name: 'WEIXIN_ALLOWED_USERS', label: 'Allowed Weixin user IDs', placeholder: 'optional allowlist' },
      { name: 'WEIXIN_DM_POLICY', label: 'DM policy', placeholder: 'pairing, open, allowlist, or disabled' },
      { name: 'WEIXIN_GROUP_POLICY', label: 'Group policy', placeholder: 'disabled, open, or allowlist' },
      { name: 'WEIXIN_GROUP_ALLOWED_USERS', label: 'Allowed group users', placeholder: 'optional allowlist' },
      { name: 'WEIXIN_SPLIT_MULTILINE_MESSAGES', label: 'Split multiline messages', placeholder: 'true or false' },
    ],
    pairing: {
      type: 'qr',
      provider: 'weixin_ilink_qr',
      label: 'Weixin login QR',
      description: 'ToolPlane requests an iLink login QR and polls Weixin for account/session data after confirmation.',
      scanTarget: 'WeChat mobile app',
      completion: 'After login, save the generated account ID/token and start the long-poll runner.',
      requestLabel: 'Request Weixin QR',
      checkLabel: 'Check Weixin login',
    },
    setupSteps: [
      'Start the Weixin setup wizard.',
      'Scan the QR code with the WeChat mobile app and confirm login.',
      'Save the generated account ID/token and start the long-poll worker.',
    ],
    operatorNotes: ['This is for personal WeChat through iLink, not WeCom enterprise chat. Group delivery depends on Tencent iLink behavior.'],
    capabilities: { voice: true, images: true, files: true, typing: true, streaming: true },
  },
  {
    slug: 'bluebubbles',
    label: 'BlueBubbles',
    kind: 'bridge',
    summary: 'BlueBubbles iMessage bridge events.',
    requiredEnv: ['BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD'],
    setupFlow: 'bridge_pairing',
    primaryAction: 'Connect BlueBubbles server',
    connectionMode: 'Bridge worker talks to a user-run BlueBubbles server.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'BLUEBUBBLES_SERVER_URL', label: 'BlueBubbles server URL', required: true },
      { name: 'BLUEBUBBLES_PASSWORD', label: 'BlueBubbles password', required: true, secret: true },
    ],
    setupSteps: [
      'Run BlueBubbles on a Mac signed into iMessage.',
      'Save the server URL and password in the platform worker.',
      'Allow contacts or chats before enabling replies.',
    ],
    capabilities: { images: true, files: true, reactions: true, typing: true },
  },
  {
    slug: 'qqbot',
    label: 'QQ',
    kind: 'bot',
    summary: 'QQ bot messages and media.',
    requiredEnv: ['QQBOT_APP_ID', 'QQBOT_SECRET'],
    setupFlow: 'gateway_bot',
    primaryAction: 'Save QQ bot credentials',
    connectionMode: 'QQ bot gateway or webhook worker.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'QQBOT_APP_ID', label: 'App ID', required: true },
      { name: 'QQBOT_SECRET', label: 'Secret', required: true, secret: true },
      { name: 'QQBOT_ALLOWED_USERS', label: 'Allowed QQ users', placeholder: 'optional allowlist' },
    ],
    setupSteps: [
      'Create a QQ bot app and copy App ID and Secret.',
      'Configure event permissions in the QQ developer console.',
      'Start the QQ worker and verify inbound messages.',
    ],
    capabilities: { voice: true, images: true, files: true, typing: true },
  },
  {
    slug: 'yuanbao',
    label: 'Yuanbao',
    kind: 'bridge',
    summary: 'Yuanbao chat bridge events, media, and streaming updates.',
    requiredEnv: ['YUANBAO_ALLOWED_USERS'],
    setupFlow: 'bridge_pairing',
    primaryAction: 'Pair Yuanbao bridge',
    connectionMode: 'Bridge worker runs a Yuanbao session.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'YUANBAO_ALLOWED_USERS', label: 'Allowed Yuanbao users', required: true },
      { name: 'YUANBAO_SESSION_PATH', label: 'Session path', placeholder: '~/.toolplane/yuanbao' },
    ],
    pairing: {
      type: 'qr',
      provider: 'external_setup_runner',
      label: 'Yuanbao pairing QR',
      description: 'ToolPlane starts the configured Yuanbao setup runner and displays the returned QR.',
      scanTarget: 'Yuanbao mobile app',
      completion: 'After pairing, keep the session path and allowed user list on this channel.',
      requestLabel: 'Request Yuanbao QR',
    },
    setupSteps: [
      'Start the Yuanbao bridge worker.',
      'Complete any required browser or QR pairing step.',
      'Restrict allowed users before enabling responses.',
    ],
    capabilities: { voice: true, images: true, files: true, typing: true, streaming: true },
  },
  {
    slug: 'teams',
    label: 'Microsoft Teams',
    kind: 'webhook',
    summary: 'Microsoft Teams bot and meeting/chat events.',
    requiredEnv: ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_ALLOWED_USERS'],
    setupFlow: 'platform_app',
    primaryAction: 'Register Teams bot',
    connectionMode: 'Bot Framework messaging endpoint and Microsoft app credentials.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'TEAMS_APP_ID', label: 'Microsoft App ID', required: true },
      { name: 'TEAMS_APP_PASSWORD', label: 'Microsoft App password', required: true, secret: true },
      { name: 'TEAMS_ALLOWED_USERS', label: 'Allowed Teams users', required: true },
    ],
    setupSteps: [
      'Create a Microsoft Bot Framework registration or Teams app.',
      'Expose the channel messaging endpoint through HTTPS.',
      'Install the Teams app into the tenant or team.',
    ],
    capabilities: { images: true, threads: true, typing: true },
  },
  {
    slug: 'teams_meetings',
    label: 'Teams Meetings',
    kind: 'webhook',
    summary: 'Microsoft Teams meeting event adapter.',
    requiredEnv: ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD'],
    setupFlow: 'platform_app',
    primaryAction: 'Configure meeting app',
    connectionMode: 'Teams meeting app and Bot Framework callbacks.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'TEAMS_APP_ID', label: 'Microsoft App ID', required: true },
      { name: 'TEAMS_APP_PASSWORD', label: 'Microsoft App password', required: true, secret: true },
      { name: 'TEAMS_MEETING_ALLOWED_USERS', label: 'Allowed organizers or users' },
    ],
    setupSteps: [
      'Create or extend a Teams app with meeting permissions.',
      'Configure bot callback endpoints and tenant installation.',
      'Forward meeting chat or transcript turns into the agent session.',
    ],
    capabilities: { voice: true, threads: true },
  },
  {
    slug: 'msgraph_webhook',
    label: 'MS Graph Webhook',
    kind: 'webhook',
    summary: 'Microsoft Graph webhook callbacks for mail, chat, calendar, or Teams-related events.',
    requiredEnv: ['MSGRAPH_CLIENT_ID', 'MSGRAPH_CLIENT_SECRET'],
    setupFlow: 'cloud_webhook',
    primaryAction: 'Create Graph subscription',
    connectionMode: 'Microsoft Graph sends validation and change notifications to HTTPS callbacks.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'MSGRAPH_CLIENT_ID', label: 'Client ID', required: true },
      { name: 'MSGRAPH_CLIENT_SECRET', label: 'Client secret', required: true, secret: true },
      { name: 'MSGRAPH_TENANT_ID', label: 'Tenant ID', required: true },
    ],
    setupSteps: [
      'Create an Azure app registration with required Graph permissions.',
      'Expose a notification URL that can answer Graph validation requests.',
      'Create subscriptions and renew them before expiration.',
    ],
    capabilities: { files: true, threads: true },
  },
  {
    slug: 'line',
    label: 'LINE',
    kind: 'webhook',
    summary: 'LINE Messaging API webhook events.',
    requiredEnv: ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'],
    setupFlow: 'webhook_callback',
    primaryAction: 'Configure LINE webhook',
    connectionMode: 'LINE Messaging API pushes signed webhook events.',
    publicEndpointRequired: true,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/line',
    credentials: [
      { name: 'LINE_CHANNEL_SECRET', label: 'Channel secret', required: true, secret: true },
      { name: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'Long-lived channel access token', required: true, secret: true },
      { name: 'LINE_ALLOWED_USERS', label: 'Allowed LINE user IDs', placeholder: 'U-prefixed IDs' },
      { name: 'LINE_ALLOWED_GROUPS', label: 'Allowed group IDs', placeholder: 'C-prefixed IDs' },
    ],
    setupSteps: [
      'Create a LINE Messaging API channel.',
      'Generate a long-lived channel access token.',
      'Set the webhook URL and verify signatures in the platform worker.',
      'Add the bot as a friend or invite it to allowed groups.',
    ],
    capabilities: { images: true, files: true, typing: true },
  },
  {
    slug: 'ntfy',
    label: 'ntfy',
    kind: 'webhook',
    summary: 'ntfy topics for lightweight notifications and replies.',
    requiredEnv: ['NTFY_TOPIC'],
    setupFlow: 'topic',
    primaryAction: 'Subscribe to ntfy topic',
    connectionMode: 'Platform worker subscribes or polls an ntfy topic.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'NTFY_TOPIC', label: 'ntfy topic', required: true },
      { name: 'NTFY_SERVER', label: 'ntfy server', placeholder: 'https://ntfy.sh' },
      { name: 'NTFY_TOKEN', label: 'Access token', secret: true },
      { name: 'NTFY_ALLOWED_USERS', label: 'Allowed publishers', placeholder: 'optional allowlist' },
    ],
    setupSteps: [
      'Choose a private ntfy topic and optional token.',
      'Start the ntfy platform subscription.',
      'Publish replies or notifications back to the same topic.',
    ],
    capabilities: {},
  },
  {
    slug: 'raft',
    label: 'Raft',
    kind: 'webhook',
    summary: 'Raft message delivery target.',
    requiredEnv: ['RAFT_TOKEN'],
    setupFlow: 'webhook_callback',
    primaryAction: 'Configure Raft callback',
    connectionMode: 'Raft sends events to a signed HTTP callback.',
    publicEndpointRequired: true,
    credentials: [
      { name: 'RAFT_TOKEN', label: 'Raft token', required: true, secret: true },
      { name: 'RAFT_ALLOWED_USERS', label: 'Allowed users', placeholder: 'optional allowlist' },
    ],
    setupSteps: [
      'Create a Raft integration token.',
      'Configure the callback route.',
      'Verify the token before invoking the agent.',
    ],
    capabilities: {},
  },
  {
    slug: 'irc',
    label: 'IRC',
    kind: 'bot',
    summary: 'IRC channel and DM bridge.',
    requiredEnv: ['IRC_SERVER', 'IRC_NICK', 'IRC_ALLOWED_USERS'],
    setupFlow: 'gateway_bot',
    primaryAction: 'Connect IRC bot',
    connectionMode: 'IRC client connection joins channels and listens for mentions or DMs.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'IRC_SERVER', label: 'IRC server', required: true, placeholder: 'irc.libera.chat:6697' },
      { name: 'IRC_NICK', label: 'Bot nickname', required: true },
      { name: 'IRC_PASSWORD', label: 'NickServ or server password', secret: true },
      { name: 'IRC_ALLOWED_USERS', label: 'Allowed nicknames', required: true },
    ],
    setupSteps: [
      'Choose the IRC network, TLS port, and bot nickname.',
      'Configure channels and allowlisted nicknames.',
      'Start the IRC platform worker so it can join channels and reply.',
    ],
    capabilities: {},
  },
  {
    slug: 'simplex',
    label: 'SimpleX',
    kind: 'bridge',
    summary: 'SimpleX chat bridge events.',
    requiredEnv: ['SIMPLEX_ALLOWED_USERS'],
    setupFlow: 'daemon',
    primaryAction: 'Connect SimpleX daemon',
    connectionMode: 'simplex-chat daemon exposes a local WebSocket API.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'SIMPLEX_WS_URL', label: 'SimpleX WebSocket URL', required: true, placeholder: 'ws://127.0.0.1:5225' },
      { name: 'SIMPLEX_ALLOWED_USERS', label: 'Allowed SimpleX contacts', required: true },
    ],
    setupSteps: [
      'Install and start simplex-chat in daemon mode.',
      'Point the platform worker at the local WebSocket URL.',
      'Allow contacts before enabling agent replies.',
    ],
    capabilities: {},
  },
  {
    slug: 'photon',
    label: 'Photon',
    kind: 'bridge',
    summary: 'Photon platform bridge events.',
    requiredEnv: ['PHOTON_PROJECT_ID', 'PHOTON_PROJECT_SECRET'],
    setupFlow: 'bridge_pairing',
    primaryAction: 'Create Photon platform worker',
    connectionMode: 'Photon platform worker holds project credentials.',
    publicEndpointRequired: false,
    credentials: [
      { name: 'PHOTON_PROJECT_ID', label: 'Project ID', required: true },
      { name: 'PHOTON_PROJECT_SECRET', label: 'Project secret', required: true, secret: true },
    ],
    setupSteps: [
      'Create or select the Photon project.',
      'Save the project ID and secret in the platform worker.',
      'Run the platform worker so it can receive events and deliver replies.',
    ],
    capabilities: { images: true, files: true },
  },
];

const PLATFORM_BY_SLUG = new Map(MESSAGING_PLATFORMS.map((platform) => [platform.slug, platform]));
const PLATFORM_ALIASES = new Map<string, MessagingPlatformSlug>([
  ['open-webui', 'open_webui'],
  ['whatsapp-cloud', 'whatsapp_cloud'],
  ['wecom-callback', 'wecom_callback'],
  ['teams-meetings', 'teams_meetings'],
  ['msgraph-webhook', 'msgraph_webhook'],
  ['google-chat', 'google_chat'],
]);

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nestedRecord(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = recordValue(raw[key]);
    if (value) return value;
  }
  return undefined;
}

function firstRecord(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = raw[key];
  if (Array.isArray(value)) return recordValue(value[0]);
  return recordValue(value);
}

function textFrom(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = textValue(raw[key]);
    if (value) return value;
  }
  return undefined;
}

function extractWhatsAppMessage(raw: Record<string, unknown>): {
  message?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
} {
  const entry = firstRecord(raw, 'entry');
  const change = entry ? firstRecord(entry, 'changes') : undefined;
  const value = change ? recordValue(change.value) : undefined;
  return {
    message: value ? firstRecord(value, 'messages') : undefined,
    contact: value ? firstRecord(value, 'contacts') : undefined,
    metadata: value ? recordValue(value.metadata) : undefined,
  };
}

export function getMessagingPlatform(slug: string): MessagingPlatform | null {
  const normalized = (PLATFORM_ALIASES.get(slug) ?? slug) as MessagingPlatformSlug;
  return PLATFORM_BY_SLUG.get(normalized) ?? null;
}

export function credentialRequiredAtCreate(credential: MessagingCredential) {
  return Boolean(credential.required && credential.requiredAt !== 'start');
}

export function missingCreateCredentialNames(platform: MessagingPlatform, credentials: Record<string, string>) {
  return platform.credentials
    .filter(credentialRequiredAtCreate)
    .filter((credential) => !credentials[credential.name]?.trim())
    .map((credential) => credential.name);
}

export function missingStartCredentialNames(platform: MessagingPlatform, credentials: Record<string, string>) {
  return platform.credentials
    .filter((credential) => credential.required)
    .filter((credential) => !credentials[credential.name]?.trim())
    .map((credential) => credential.name);
}

export function normalizePlatformMessageBody(
  platform: MessagingPlatformSlug,
  raw: unknown,
): Partial<AgentMessageBody> {
  const input = recordValue(raw) ?? {};
  const existingSource = recordValue(input.source);
  const metadata = recordValue(input.metadata) ?? input;
  const fallbackText = textFrom(input, ['message', 'text', 'content', 'body', 'subject']) ?? 'Platform event';
  let message = fallbackText;
  let chatId = textFrom(input, ['channelId', 'chatId', 'roomId', 'spaceId', 'from', 'to']);
  let userId = textFrom(input, ['externalUserId', 'userId', 'senderId', 'authorId']);
  let threadId = textFrom(input, ['threadId', 'thread_ts', 'threadTs']);
  let messageId = textFrom(input, ['messageId', 'id', 'eventId', 'ts']);
  let chatType = existingSource?.chatType as AgentMessageBody['source'] extends infer S
    ? S extends { chatType?: infer C } ? C : never
    : never;
  let scopeId = textFrom(input, ['scopeId', 'guildId', 'teamId', 'workspaceId']);

  if (platform === 'slack') {
    const event = nestedRecord(input, ['event']) ?? input;
    message = textFrom(event, ['text', 'content']) ?? message;
    chatId = textFrom(event, ['channel']) ?? chatId;
    userId = textFrom(event, ['user', 'bot_id']) ?? userId;
    threadId = textFrom(event, ['thread_ts']) ?? textFrom(event, ['ts']) ?? threadId;
    messageId = textFrom(event, ['ts', 'client_msg_id']) ?? messageId;
    scopeId = textFrom(input, ['team_id', 'teamId']) ?? scopeId;
    chatType = 'channel';
  } else if (platform === 'discord') {
    const author = recordValue(input.author);
    message = textFrom(input, ['content']) ?? message;
    chatId = textFrom(input, ['channel_id', 'channelId']) ?? chatId;
    userId = textValue(author?.id) ?? textFrom(input, ['user_id', 'userId']) ?? userId;
    threadId = textFrom(input, ['thread_id', 'threadId']) ?? threadId;
    messageId = textFrom(input, ['id']) ?? messageId;
    scopeId = textFrom(input, ['guild_id', 'guildId']) ?? scopeId;
    chatType = threadId ? 'thread' : 'channel';
  } else if (platform === 'telegram') {
    const msg = nestedRecord(input, ['message', 'edited_message', 'channel_post']) ?? input;
    const chat = recordValue(msg.chat);
    const from = recordValue(msg.from);
    message = textFrom(msg, ['text', 'caption']) ?? message;
    chatId = textValue(chat?.id) ?? chatId;
    userId = textValue(from?.id) ?? userId;
    threadId = textFrom(msg, ['message_thread_id']) ?? threadId;
    messageId = textFrom(msg, ['message_id']) ?? messageId;
    const telegramType = textValue(chat?.type);
    chatType = telegramType === 'private' ? 'dm' : 'group';
  } else if (platform === 'whatsapp_cloud') {
    const { message: waMessage, contact, metadata: waMeta } = extractWhatsAppMessage(input);
    const text = recordValue(waMessage?.text);
    message = textValue(text?.body) ?? message;
    chatId = textValue(waMeta?.phone_number_id) ?? chatId;
    userId = textValue(waMessage?.from) ?? textValue(contact?.wa_id) ?? userId;
    messageId = textValue(waMessage?.id) ?? messageId;
    chatType = 'dm';
  } else if (platform === 'google_chat') {
    const msg = recordValue(input.message) ?? input;
    const sender = recordValue(msg.sender);
    const space = recordValue(msg.space);
    message = textFrom(msg, ['text', 'argumentText']) ?? message;
    chatId = textValue(space?.name) ?? chatId;
    userId = textValue(sender?.name) ?? userId;
    threadId = textValue(recordValue(msg.thread)?.name) ?? threadId;
    messageId = textValue(msg.name) ?? messageId;
    chatType = 'channel';
  } else if (platform === 'teams') {
    const from = recordValue(input.from);
    const conversation = recordValue(input.conversation);
    message = textFrom(input, ['text', 'content']) ?? message;
    chatId = textValue(conversation?.id) ?? chatId;
    userId = textValue(from?.id) ?? userId;
    messageId = textFrom(input, ['id']) ?? messageId;
    chatType = 'channel';
  } else if (platform === 'email') {
    const subject = textFrom(input, ['subject']);
    const body = textFrom(input, ['text', 'body', 'html']);
    message = [subject ? `Subject: ${subject}` : null, body].filter(Boolean).join('\n\n') || message;
    chatId = textFrom(input, ['threadId', 'messageId', 'from']) ?? chatId;
    userId = textFrom(input, ['from', 'sender']) ?? userId;
    threadId = textFrom(input, ['threadId', 'inReplyTo']) ?? threadId;
    messageId = textFrom(input, ['messageId', 'id']) ?? messageId;
    chatType = 'thread';
  }

  return {
    message,
    conversationId: textFrom(input, ['conversationId']),
    messageType: (textFrom(input, ['messageType', 'type']) as AgentMessageBody['messageType']) ?? 'text',
    attachments: Array.isArray(input.attachments) ? input.attachments as AgentMessageBody['attachments'] : [],
    metadata,
    source: {
      ...existingSource,
      platform,
      chatId: textValue(existingSource?.chatId) ?? chatId,
      chatName: textValue(existingSource?.chatName),
      chatType: (existingSource?.chatType as AgentMessageBody['source'] extends infer S
        ? S extends { chatType?: infer C } ? C : never
        : never) ?? chatType ?? (chatId ? 'channel' : 'dm'),
      userId: textValue(existingSource?.userId) ?? userId,
      userName: textValue(existingSource?.userName),
      threadId: textValue(existingSource?.threadId) ?? threadId,
      parentChatId: textValue(existingSource?.parentChatId),
      scopeId: textValue(existingSource?.scopeId) ?? scopeId,
      messageId: textValue(existingSource?.messageId) ?? messageId,
    },
  };
}
