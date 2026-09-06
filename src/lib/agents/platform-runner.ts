import { getMessagingPlatform } from './platforms';

const ADAPTERS: Record<string, string> = {
  telegram: 'TelegramAdapter', feishu: 'FeishuAdapter', qqbot: 'QqAdapter',
  weixin: 'WeChatAdapter', discord: 'DiscordAdapter', slack: 'SlackAdapter',
};

export function hostedRunnerSpec(platform: string) {
  const className = Object.hasOwn(ADAPTERS, platform) ? ADAPTERS[platform] : undefined;
  if (!className) return null;
  return {
    platform, runtime: 'node' as const, className,
    requiredEnv: getMessagingPlatform(platform)!.credentials.filter((field) => field.required).map((field) => field.name),
  };
}
