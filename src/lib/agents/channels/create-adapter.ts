import "server-only";
import type { ChannelAdapter } from "./ChannelAdapter";

export async function createChannelAdapter(input: {
  id: string;
  agentId: string;
  platform: string;
  credentials: Record<string, string>;
}): Promise<ChannelAdapter> {
  const c = input.credentials;
  const common = { channelId: input.id, agentId: input.agentId };
  switch (input.platform) {
    case "telegram": {
      const { TelegramAdapter } = await import(
        "./adapters/telegram/TelegramAdapter"
      );
      return new TelegramAdapter({
        ...common,
        channelType: "telegram",
        channelConfig: {
          bot_token: c.TELEGRAM_BOT_TOKEN,
        },
      });
    }
    case "feishu": {
      const { FeishuAdapter } = await import("./adapters/feishu/FeishuAdapter");
      return new FeishuAdapter({
        ...common,
        channelType: "feishu",
        channelConfig: {
          app_id: c.FEISHU_APP_ID,
          app_secret: c.FEISHU_APP_SECRET,
          encrypt_key: c.FEISHU_ENCRYPT_KEY ?? "",
          verification_token: c.FEISHU_VERIFICATION_TOKEN ?? "",
          domain: c.FEISHU_DOMAIN === "lark" ? "lark" : "feishu",
        },
      });
    }
    case "qqbot": {
      const { QqAdapter } = await import("./adapters/qq/QqAdapter");
      return new QqAdapter({
        ...common,
        channelType: "qq",
        channelConfig: {
          app_id: c.QQBOT_APP_ID,
          client_secret: c.QQBOT_SECRET,
          mention_only: c.QQBOT_REQUIRE_MENTION !== "false",
        },
      });
    }
    case "weixin": {
      const { WeChatAdapter } = await import("./adapters/wechat/WeChatAdapter");
      return new WeChatAdapter({
        ...common,
        channelType: "wechat",
        channelConfig: {
          token: c.WEIXIN_TOKEN,
          accountId: c.WEIXIN_ACCOUNT_ID,
          baseUrl: c.WEIXIN_BASE_URL,
        },
      });
    }
    case "discord": {
      const { DiscordAdapter } = await import(
        "./adapters/discord/DiscordAdapter"
      );
      return new DiscordAdapter({
        ...common,
        channelType: "discord",
        channelConfig: {
          bot_token: c.DISCORD_BOT_TOKEN,
        },
      });
    }
    case "slack": {
      const { SlackAdapter } = await import("./adapters/slack/SlackAdapter");
      return new SlackAdapter({
        ...common,
        channelType: "slack",
        channelConfig: {
          bot_token: c.SLACK_BOT_TOKEN,
          app_token: c.SLACK_APP_TOKEN,
        },
      });
    }
    default:
      throw new Error("This platform has no native channel transport.");
  }
}
