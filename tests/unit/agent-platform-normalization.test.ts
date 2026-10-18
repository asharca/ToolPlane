import { describe, expect, it } from "vitest";
import { normalizePlatformMessageBody } from "@/lib/agents/platforms";
import type { MessagingPlatformSlug } from "@/lib/agents/platforms";

describe("platform inbound normalization boundaries", () => {
  it.each([null, [], false, 10, "message"])(
    "normalizes non-record input %j without inventing sender identity",
    (raw) => {
      expect(normalizePlatformMessageBody("api", raw)).toMatchObject({
        message: "Platform event",
        messageType: "text",
        attachments: [],
        source: {
          platform: "api",
          chatType: "dm",
          userId: undefined,
          chatId: undefined,
        },
      });
    },
  );
  it("preserves explicit source identity over inferred transport fields and retains attachments and metadata", () => {
    const attachments = [{ name: "notes", url: "https://files.example/notes" }];
    const metadata = { correlation: "trace" };
    expect(
      normalizePlatformMessageBody("discord", {
        content: " hi ",
        channel_id: "inferred",
        author: { id: "inferred" },
        id: "inferred",
        attachments,
        metadata,
        conversationId: " c ",
        messageType: "image",
        source: {
          platform: "wrong",
          chatId: "explicit",
          chatName: "room",
          userId: "user",
          userName: "Alice",
          chatType: "dm",
          threadId: "thread",
          parentChatId: "parent",
          scopeId: "scope",
          messageId: "message",
        },
      }),
    ).toEqual({
      message: "hi",
      conversationId: "c",
      messageType: "image",
      attachments,
      metadata,
      source: {
        platform: "discord",
        chatId: "explicit",
        chatName: "room",
        userId: "user",
        userName: "Alice",
        chatType: "dm",
        threadId: "thread",
        parentChatId: "parent",
        scopeId: "scope",
        messageId: "message",
      },
    });
  });
  it.each([
    [
      "message",
      "channelId",
      "externalUserId",
      "threadId",
      "messageId",
      "scopeId",
    ],
    ["text", "chatId", "userId", "thread_ts", "id", "guildId"],
    ["content", "roomId", "senderId", "threadTs", "eventId", "teamId"],
    ["body", "spaceId", "authorId", "threadId", "ts", "workspaceId"],
    ["subject", "from", "userId", "threadId", "id", "scopeId"],
    ["subject", "to", "userId", "threadId", "id", "scopeId"],
  ])(
    "accepts generic payload aliases %s/%s/%s",
    (text, chat, user, thread, id, scope) => {
      const result = normalizePlatformMessageBody("matrix", {
        [text]: " hello ",
        [chat]: "room",
        [user]: 123,
        [thread]: "thread",
        [id]: 456,
        [scope]: "scope",
        attachments: {},
        type: "custom",
      });
      expect(result).toMatchObject({
        message: "hello",
        messageType: "custom",
        attachments: [],
        source: {
          chatId: "room",
          userId: "123",
          threadId: "thread",
          messageId: "456",
          scopeId: "scope",
          chatType: "channel",
        },
      });
    },
  );
  it.each([
    [
      "slack",
      {
        event: {
          text: "slack",
          channel: "room",
          bot_id: "bot",
          client_msg_id: "msg",
        },
        team_id: "team",
      },
      "slack",
      {
        chatId: "room",
        userId: "bot",
        messageId: "msg",
        scopeId: "team",
        chatType: "channel",
      },
    ],
    [
      "slack",
      { text: "direct", channel: "room", user: "u", ts: "1" },
      "direct",
      { userId: "u", threadId: "1", messageId: "1" },
    ],
    [
      "discord",
      {
        content: "discord",
        channel_id: "room",
        user_id: "u",
        guild_id: "guild",
        thread_id: "thread",
      },
      "discord",
      {
        chatId: "room",
        userId: "u",
        scopeId: "guild",
        threadId: "thread",
        chatType: "thread",
      },
    ],
    [
      "telegram",
      {
        edited_message: {
          caption: "edited",
          chat: { id: -100, type: "supergroup" },
          from: { id: 42 },
          message_thread_id: 9,
          message_id: 8,
        },
      },
      "edited",
      {
        chatId: "-100",
        userId: "42",
        threadId: "9",
        messageId: "8",
        chatType: "group",
      },
    ],
    [
      "telegram",
      { channel_post: { text: "post", chat: { id: 1, type: "private" } } },
      "post",
      { chatId: "1", chatType: "dm" },
    ],
    [
      "google_chat",
      {
        message: {
          argumentText: "google",
          sender: { name: "users/u" },
          space: { name: "spaces/s" },
          thread: { name: "threads/t" },
          name: "messages/m",
        },
      },
      "google",
      {
        chatId: "spaces/s",
        userId: "users/u",
        threadId: "threads/t",
        messageId: "messages/m",
        chatType: "channel",
      },
    ],
    [
      "teams",
      {
        content: "teams",
        conversation: { id: "room" },
        from: { id: "u" },
        id: "m",
      },
      "teams",
      { chatId: "room", userId: "u", messageId: "m", chatType: "channel" },
    ],
    [
      "email",
      {
        subject: " Status ",
        html: "<p>ready</p>",
        sender: "alice",
        messageId: "m",
        inReplyTo: "parent",
      },
      "Subject: Status\n\n<p>ready</p>",
      {
        chatId: "m",
        userId: "alice",
        messageId: "m",
        threadId: "parent",
        chatType: "thread",
      },
    ],
    [
      "email",
      { body: "body", from: "alice" },
      "body",
      { chatId: "alice", userId: "alice", chatType: "thread" },
    ],
  ] satisfies [
    MessagingPlatformSlug,
    unknown,
    string,
    Record<string, string>,
  ][])(
    "normalizes %s protocol-specific sender and conversation identity",
    (platform, raw, message, source) => {
      expect(normalizePlatformMessageBody(platform, raw)).toMatchObject({
        message,
        source,
      });
    },
  );
  it.each([true, false])(
    "normalizes WhatsApp Cloud nested %s collection shape",
    (arrays) => {
      const value = {
        messages: arrays
          ? [{ from: "sender", id: "m", text: { body: "hello" } }]
          : { id: "m", text: { body: "hello" } },
        contacts: { wa_id: "contact" },
        metadata: { phone_number_id: "phone" },
      };
      const changes = { value };
      const entry = { changes: arrays ? [changes] : changes };
      const result = normalizePlatformMessageBody("whatsapp_cloud", {
        entry: arrays ? [entry] : entry,
      });
      expect(result).toMatchObject({
        message: "hello",
        source: {
          chatId: "phone",
          userId: arrays ? "sender" : "contact",
          messageId: "m",
          chatType: "dm",
        },
      });
    },
  );
  it.each([
    "slack",
    "discord",
    "telegram",
    "whatsapp_cloud",
    "google_chat",
    "teams",
    "email",
  ] as const)(
    "retains generic fallback identities for sparse %s events",
    (platform) => {
      expect(
        normalizePlatformMessageBody(platform, {
          body: "fallback",
          chatId: "chat",
          userId: "user",
          threadId: "thread",
          messageId: "message",
          scopeId: "scope",
          source: { chatId: " ", userId: NaN },
          author: [],
          event: [],
          metadata: [],
        }),
      ).toMatchObject({
        message: "fallback",
        source: {
          chatId: platform === "email" ? "thread" : "chat",
          userId: "user",
          threadId: "thread",
          messageId: "message",
          scopeId: "scope",
        },
      });
    },
  );
  it.each([
    { entry: [] },
    { entry: [{ changes: [] }] },
    { entry: [{ changes: [{ value: null }] }] },
    { entry: [{ changes: [{ value: { messages: [], contacts: [] } }] }] },
  ])("handles WhatsApp delivery-only events %j", (raw) => {
    expect(normalizePlatformMessageBody("whatsapp_cloud", raw)).toMatchObject({
      message: "Platform event",
      source: { chatType: "dm", userId: undefined, chatId: undefined },
    });
  });
});
