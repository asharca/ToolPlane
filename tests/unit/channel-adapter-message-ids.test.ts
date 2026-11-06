import { Api, Bot } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelCommandEvent,
  ChannelMessageEvent,
} from "@/lib/agents/channels/ChannelAdapter";
import { DiscordAdapter } from "@/lib/agents/channels/adapters/discord/DiscordAdapter";
import { SlackAdapter } from "@/lib/agents/channels/adapters/slack/SlackAdapter";
import { TelegramAdapter } from "@/lib/agents/channels/adapters/telegram/TelegramAdapter";
import { normalizePlatformMessageBody } from "@/lib/agents/platforms";

// Native channel execution rejects inbound events without a stable platform message ID.
type Inbound = ChannelMessageEvent | ChannelCommandEvent;
type Handler = (...args: unknown[]) => Promise<void>;

// Inbound handlers are private; driving them avoids opening real platform sockets.
function privateHandler(adapter: object, name: string): Handler {
  const handler: unknown = Reflect.get(adapter, name);
  if (typeof handler !== "function") throw new Error(`Missing ${name}`);
  return (...args) => handler.apply(adapter, args);
}

const common = { channelId: "connection", agentId: "agent" };

function collect(adapter: {
  on: (name: string, fn: (e: Inbound) => void) => unknown;
}) {
  const events: Inbound[] = [];
  adapter.on("message", (event) => events.push(event));
  adapter.on("command", (event) => events.push(event));
  return events;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("channel adapters carry platform message IDs", () => {
  it("Discord messages, text commands and slash interactions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const adapter = new DiscordAdapter({
      ...common,
      channelType: "discord",
      channelConfig: { bot_token: "token" },
    });
    const events = collect(adapter);
    const dispatch = privateHandler(adapter, "handleDispatch");
    const message = (id: string, content: string) => ({
      id,
      channel_id: "42",
      guild_id: "7",
      author: { id: "u1", username: "user" },
      content,
      timestamp: "2026-11-05T00:00:00Z",
    });
    await dispatch("MESSAGE_CREATE", message("1001", "hello"));
    await dispatch("MESSAGE_CREATE", message("1002", "/compact"));
    await dispatch("INTERACTION_CREATE", {
      id: "1003",
      token: "interaction-token",
      type: 2,
      channel_id: "42",
      guild_id: "7",
      member: { user: { id: "u1", username: "user" }, roles: [] },
      data: { name: "help" },
    });
    expect(events.map((event) => event.messageId)).toEqual([
      "1001",
      "1002",
      "1003",
    ]);
    await dispatch("MESSAGE_CREATE", {
      ...message("1004", "direct"),
      guild_id: undefined,
    });
    await dispatch("MESSAGE_CREATE", {
      ...message("1005", "topic"),
      channel: { type: 11 },
    });
    expect(events.map((event) => event.chatType)).toEqual([
      "channel",
      "channel",
      "channel",
      "dm",
      "thread",
    ]);
    expect(events[4].threadId).toBe("42");
  });

  it("Slack messages, text commands and slash commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, user: { name: "user" } }), {
            status: 200,
          }),
      ),
    );
    const adapter = new SlackAdapter({
      ...common,
      channelType: "slack",
      channelConfig: { bot_token: "xoxb", app_token: "xapp" },
    });
    const events = collect(adapter);
    const handleSocketMessage = privateHandler(adapter, "handleSocketMessage");
    const receive = (envelope: object) =>
      handleSocketMessage(Buffer.from(JSON.stringify(envelope)));
    const event = (ts: string, text: string) => ({
      envelope_id: `env-${ts}`,
      type: "events_api",
      payload: {
        event: { type: "message", channel: "C1", user: "U1", text, ts },
      },
    });
    await receive(event("1730764800.000100", "hello"));
    await receive(event("1730764800.000200", "/compact"));
    await receive({
      envelope_id: "env-slash",
      type: "slash_commands",
      payload: { command: "/help", channel_id: "C1", user_id: "U1" },
    });
    expect(events.map((item) => item.messageId)).toEqual([
      "1730764800.000100",
      "1730764800.000200",
      "env-slash",
    ]);
    const contextEvent = (
      ts: string,
      channel_type: string,
      thread_ts?: string,
    ) => ({
      envelope_id: `context-${ts}`,
      type: "events_api",
      payload: {
        event: {
          type: "message",
          channel: "C1",
          user: "U1",
          text: "context",
          ts,
          channel_type,
          thread_ts,
        },
      },
    });
    await receive(contextEvent("1", "im"));
    await receive(contextEvent("2", "channel", "2"));
    await receive(contextEvent("3", "channel", "2"));
    expect(
      events
        .slice(3)
        .map((item) => ({ chatType: item.chatType, threadId: item.threadId })),
    ).toEqual([
      { chatType: "dm", threadId: undefined },
      { chatType: "channel", threadId: undefined },
      { chatType: "thread", threadId: "2" },
    ]);
  });

  it("Telegram messages and commands", async () => {
    vi.spyOn(Api.prototype, "setMyCommands").mockResolvedValue(true);
    vi.spyOn(Bot.prototype, "start").mockReturnValue(new Promise(() => {}));
    const adapter = new TelegramAdapter({
      ...common,
      channelType: "telegram",
      channelConfig: { bot_token: "123:token" },
    });
    const events = collect(adapter);
    await adapter.connect();
    const bot: unknown = Reflect.get(adapter, "bot");
    if (!(bot instanceof Bot)) throw new Error("Telegram bot was not created");
    bot.botInfo = {
      id: 123,
      is_bot: true,
      first_name: "bot",
      username: "tp_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    };
    const update = (id: number, text: string) =>
      bot.handleUpdate({
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: 9, type: "private", first_name: "user" },
          from: { id: 5, is_bot: false, first_name: "user" },
          text,
          ...(text.startsWith("/")
            ? {
                entities: [
                  { type: "bot_command", offset: 0, length: text.length },
                ],
              }
            : {}),
        },
      });
    await update(31, "hello");
    await update(32, "/help");
    expect(events.map((event) => event.messageId)).toEqual(["31", "32"]);
    await bot.handleUpdate({
      update_id: 33,
      message: {
        message_id: 33,
        date: 0,
        chat: { id: -9, type: "group", title: "Group" },
        from: { id: 5, is_bot: false, first_name: "user" },
        text: "group",
      },
    });
    await bot.handleUpdate({
      update_id: 34,
      message: {
        message_id: 34,
        date: 0,
        chat: { id: -9, type: "supergroup", title: "Topics", is_forum: true },
        from: { id: 5, is_bot: false, first_name: "user" },
        text: "topic",
        message_thread_id: 7,
      },
    });
    expect(
      events.map((event) => ({
        chatType: event.chatType,
        threadId: event.threadId,
      })),
    ).toEqual([
      { chatType: "dm", threadId: undefined },
      { chatType: "dm", threadId: undefined },
      { chatType: "group", threadId: undefined },
      { chatType: "thread", threadId: "7" },
    ]);
    await adapter.disconnect();
  });
});

it("Slack callback normalization does not treat the root timestamp as a thread", () => {
  expect(
    normalizePlatformMessageBody("slack", {
      event: {
        text: "root",
        channel: "C1",
        channel_type: "channel",
        ts: "1",
        thread_ts: "1",
      },
    }).source,
  ).toMatchObject({ chatType: "channel", threadId: undefined });
  expect(
    normalizePlatformMessageBody("slack", {
      event: {
        text: "reply",
        channel: "C1",
        channel_type: "channel",
        ts: "2",
        thread_ts: "1",
      },
    }).source,
  ).toMatchObject({ chatType: "thread", threadId: "1" });
  expect(
    normalizePlatformMessageBody("slack", {
      event: { text: "direct", channel: "D1", channel_type: "im", ts: "3" },
    }).source,
  ).toMatchObject({ chatType: "dm", threadId: undefined });
});
