import type { MessagingPlatformSlug } from '@/lib/agents/platforms';

export type HostedRunnerPlatform = Extract<MessagingPlatformSlug, 'telegram' | 'slack' | 'discord' | 'wecom' | 'weixin' | 'dingtalk'>;

export type HostedRunnerSpec = {
  platform: HostedRunnerPlatform;
  runtime: 'hermes-python';
  importPath: string;
  className: string;
  tokenEnv?: string;
  requiredEnv: string[];
  optionalEnv: string[];
  configExtraEnv?: Record<string, string>;
  note: string;
};

export const HERMES_SOURCE_URL = 'https://github.com/NousResearch/hermes-agent';
export const HERMES_LICENSE = 'MIT';

export const HOSTED_RUNNER_SPECS: Record<HostedRunnerPlatform, HostedRunnerSpec> = {
  telegram: {
    platform: 'telegram',
    runtime: 'hermes-python',
    importPath: 'plugins.platforms.telegram.adapter',
    className: 'TelegramAdapter',
    tokenEnv: 'TELEGRAM_BOT_TOKEN',
    requiredEnv: ['TELEGRAM_BOT_TOKEN'],
    optionalEnv: ['TELEGRAM_ALLOWED_USERS', 'TELEGRAM_ALLOW_ALL_USERS', 'TELEGRAM_ALLOWED_CHATS', 'TELEGRAM_ALLOWED_TOPICS', 'TELEGRAM_WEBHOOK_URL'],
    note: 'Platform runner imports Hermes TelegramAdapter and receives updates through polling by default.',
  },
  slack: {
    platform: 'slack',
    runtime: 'hermes-python',
    importPath: 'plugins.platforms.slack.adapter',
    className: 'SlackAdapter',
    tokenEnv: 'SLACK_BOT_TOKEN',
    requiredEnv: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_ALLOWED_USERS'],
    optionalEnv: ['SLACK_ALLOWED_CHANNELS', 'SLACK_REPLY_IN_THREAD', 'SLACK_PROXY_URL'],
    note: 'Platform runner imports Hermes SlackAdapter and opens Socket Mode from the server.',
  },
  discord: {
    platform: 'discord',
    runtime: 'hermes-python',
    importPath: 'plugins.platforms.discord.adapter',
    className: 'DiscordAdapter',
    tokenEnv: 'DISCORD_BOT_TOKEN',
    requiredEnv: ['DISCORD_BOT_TOKEN'],
    optionalEnv: ['DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_ROLES', 'DISCORD_ALLOWED_GUILDS', 'DISCORD_REQUIRE_MENTION', 'DISCORD_ALLOW_ALL_USERS', 'DISCORD_HOME_CHANNEL'],
    note: 'Platform runner imports Hermes DiscordAdapter and connects the Gateway bot from the server.',
  },
  wecom: {
    platform: 'wecom',
    runtime: 'hermes-python',
    importPath: 'plugins.platforms.wecom.adapter',
    className: 'WeComAdapter',
    requiredEnv: ['WECOM_BOT_ID', 'WECOM_SECRET'],
    optionalEnv: [
      'WECOM_ALLOWED_USERS',
      'WECOM_WEBSOCKET_URL',
      'WECOM_HOME_CHANNEL',
      'WECOM_DM_POLICY',
      'WECOM_GROUP_POLICY',
      'WECOM_GROUP_ALLOW_FROM',
      'WECOM_GROUPS_JSON',
    ],
    configExtraEnv: {
      bot_id: 'WECOM_BOT_ID',
      secret: 'WECOM_SECRET',
      websocket_url: 'WECOM_WEBSOCKET_URL',
      dm_policy: 'WECOM_DM_POLICY',
      group_policy: 'WECOM_GROUP_POLICY',
      group_allow_from: 'WECOM_GROUP_ALLOW_FROM',
      groups: 'WECOM_GROUPS_JSON',
    },
    note: 'Platform runner imports Hermes WeComAdapter and keeps the WeCom AI Bot WebSocket on the server.',
  },
  weixin: {
    platform: 'weixin',
    runtime: 'hermes-python',
    importPath: 'gateway.platforms.weixin',
    className: 'WeixinAdapter',
    tokenEnv: 'WEIXIN_TOKEN',
    requiredEnv: ['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID'],
    optionalEnv: [
      'WEIXIN_BASE_URL',
      'WEIXIN_CDN_BASE_URL',
      'WEIXIN_ALLOWED_USERS',
      'WEIXIN_DM_POLICY',
      'WEIXIN_GROUP_POLICY',
      'WEIXIN_GROUP_ALLOWED_USERS',
      'WEIXIN_SPLIT_MULTILINE_MESSAGES',
      'WEIXIN_HOME_CHANNEL',
      'WEIXIN_HOME_CHANNEL_NAME',
    ],
    configExtraEnv: {
      token: 'WEIXIN_TOKEN',
      account_id: 'WEIXIN_ACCOUNT_ID',
      base_url: 'WEIXIN_BASE_URL',
      cdn_base_url: 'WEIXIN_CDN_BASE_URL',
      allow_from: 'WEIXIN_ALLOWED_USERS',
      dm_policy: 'WEIXIN_DM_POLICY',
      group_policy: 'WEIXIN_GROUP_POLICY',
      group_allow_from: 'WEIXIN_GROUP_ALLOWED_USERS',
      split_multiline_messages: 'WEIXIN_SPLIT_MULTILINE_MESSAGES',
    },
    note: 'Platform runner imports Hermes WeixinAdapter and long-polls Tencent iLink from the server.',
  },
  dingtalk: {
    platform: 'dingtalk',
    runtime: 'hermes-python',
    importPath: 'plugins.platforms.dingtalk.adapter',
    className: 'DingTalkAdapter',
    requiredEnv: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
    optionalEnv: [
      'DINGTALK_ALLOWED_USERS',
      'DINGTALK_HOME_CHANNEL',
      'DINGTALK_HOME_CHANNEL_NAME',
      'DINGTALK_REQUIRE_MENTION',
      'DINGTALK_FREE_RESPONSE_CHATS',
      'DINGTALK_ALLOWED_CHATS',
      'DINGTALK_WEBHOOK_URL',
    ],
    configExtraEnv: {
      client_id: 'DINGTALK_CLIENT_ID',
      client_secret: 'DINGTALK_CLIENT_SECRET',
      allowed_users: 'DINGTALK_ALLOWED_USERS',
      require_mention: 'DINGTALK_REQUIRE_MENTION',
      free_response_chats: 'DINGTALK_FREE_RESPONSE_CHATS',
      allowed_chats: 'DINGTALK_ALLOWED_CHATS',
      webhook_url: 'DINGTALK_WEBHOOK_URL',
    },
    note: 'Platform runner imports Hermes DingTalkAdapter and opens DingTalk Stream Mode from the server.',
  },
};

export function hostedRunnerSpec(platform: string): HostedRunnerSpec | null {
  return HOSTED_RUNNER_SPECS[platform as HostedRunnerPlatform] ?? null;
}
