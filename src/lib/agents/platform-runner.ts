import { getMessagingPlatform } from "./platforms";

const ADAPTERS: Record<string, string> = {
  telegram: "TelegramAdapter",
  feishu: "FeishuAdapter",
  qqbot: "QqAdapter",
  weixin: "WeChatAdapter",
  discord: "DiscordAdapter",
  slack: "SlackAdapter",
};

export function hostedRunnerSpec(platform: string) {
  const className = Object.hasOwn(ADAPTERS, platform)
    ? ADAPTERS[platform]
    : undefined;
  if (!className) return null;
  const messagingPlatform = getMessagingPlatform(platform);
  if (!messagingPlatform)
    throw new Error(`Unknown messaging platform: ${platform}`);
  return {
    platform,
    runtime: "node" as const,
    className,
    requiredEnv: messagingPlatform.credentials
      .filter((field) => field.required)
      .map((field) => field.name),
  };
}
