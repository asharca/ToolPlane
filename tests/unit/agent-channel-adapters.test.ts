// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackAdapter } from "@/lib/agents/channels/adapters/slack/SlackAdapter";
import { DiscordAdapter } from "@/lib/agents/channels/adapters/discord/DiscordAdapter";
import { QqAdapter } from "@/lib/agents/channels/adapters/qq/QqAdapter";

const slack = (allowed = ["C1"]) =>
  new SlackAdapter({
    channelId: "slack",
    agentId: "a",
    channelType: "slack",
    channelConfig: {
      bot_token: "secret",
      app_token: "app",
      allowed_channel_ids: allowed,
    },
  });
const discord = (allowed = ["1"]) =>
  new DiscordAdapter({
    channelId: "discord",
    agentId: "a",
    channelType: "discord",
    channelConfig: { bot_token: "secret", allowed_channel_ids: allowed },
  });
const qq = (mentionOnly = false) =>
  new QqAdapter({
    channelId: "qq",
    agentId: "a",
    channelType: "qq",
    channelConfig: {
      app_id: "app",
      client_secret: "secret",
      allowed_chat_ids: ["group:g", "c2c:u", "channel:c", "dm:d"],
      mention_only: mentionOnly,
    },
  });
const packet = (value: unknown) => Buffer.from(JSON.stringify(value));
const qqMessage = {
  id: "m1",
  author: {
    id: "u",
    member_openid: "member",
    user_openid: "u",
    username: "Alice",
  },
  content: "<@!botABC> hello",
  timestamp: "2026-01-01",
  group_openid: "g",
  channel_id: "c",
  guild_id: "d",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Slack Socket Mode consumer behavior", () => {
  it("normalizes private attachments, resolves names once, and clears acknowledgements on reply", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Headers;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({
          url,
          body: init.body ? JSON.parse(String(init.body)) : {},
          headers: new Headers(init.headers),
        });
        if (url.includes("files.slack.com"))
          return new Response("bytes", {
            headers: {
              "content-type": url.endsWith("png")
                ? "image/png; charset=binary"
                : "text/plain",
            },
          });
        return Response.json({ ok: true, user: { real_name: "Alice" } });
      }),
    );
    const adapter = slack();
    const message = vi.fn();
    adapter.on("message", message);
    const event = {
      type: "message",
      channel: "C1",
      user: "U1",
      ts: "123",
      text: "<@BOT> hello",
      files: [
        {
          id: "i",
          name: "image.png",
          mimetype: "image/png",
          size: 5,
          url_private: "https://files.slack.com/image.png",
        },
        {
          id: "f",
          name: "notes.txt",
          mimetype: "text/plain",
          size: 5,
          url_private: "https://files.slack.com/notes.txt",
        },
        {
          id: "big",
          name: "big",
          mimetype: "text/plain",
          size: 200 * 1024 * 1024,
          url_private: "https://files.slack.com/big",
        },
      ],
    };
    await adapter["handleSocketMessage"](
      packet({ type: "events_api", payload: { event } }),
    );
    expect(message).toHaveBeenCalledWith({
      chatId: "C1",
      userId: "U1",
      userName: "Alice",
      text: "hello",
      images: [
        {
          data: Buffer.from("bytes").toString("base64"),
          media_type: "image/png",
        },
      ],
      files: [
        {
          filename: "notes.txt",
          data: Buffer.from("bytes").toString("base64"),
          media_type: "text/plain",
          size: 5,
        },
      ],
    });
    await adapter["handleSocketMessage"](
      packet({
        type: "events_api",
        payload: { event: { ...event, files: [], text: "again" } },
      }),
    );
    await adapter.sendMessage("C1", "**answer**");
    expect(requests.filter((r) => r.url.endsWith("users.info"))).toHaveLength(
      1,
    );
    expect(
      requests.find((r) => r.url.endsWith("reactions.remove"))?.body,
    ).toEqual({ channel: "C1", name: "eyes", timestamp: "123" });
    expect(requests.at(-1)?.body).toEqual({ channel: "C1", text: "*answer*" });
    expect(
      requests
        .filter((r) => r.url.includes("files.slack.com"))
        .every((r) => r.headers.get("Authorization") === "Bearer secret"),
    ).toBe(true);
  });

  it("rejects unauthorized, edited and empty events while emitting recognized commands", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const adapter = slack();
    const message = vi.fn();
    const command = vi.fn();
    adapter.on("message", message);
    adapter.on("command", command);
    for (const event of [
      { type: "message", channel: "other" },
      { type: "message", channel: "C1", subtype: "message_changed" },
      { type: "reaction_added", channel: "C1" },
    ]) {
      await adapter["handleSocketMessage"](
        packet({ type: "events_api", payload: { event } }),
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    await adapter["handleSocketMessage"](Buffer.from("invalid JSON"));
    await adapter["handleSocketMessage"](
      packet({
        type: "events_api",
        payload: {
          event: { type: "message", channel: "C1", text: "<@BOT>", ts: "1" },
        },
      }),
    );
    for (const commandName of ["/help", "/unknown"])
      await adapter["handleSocketMessage"](
        packet({
          type: "slash_commands",
          payload: {
            command: commandName,
            channel_id: "C1",
            user_id: "U1",
            user_name: "Alice",
          },
        }),
      );
    expect(message).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledExactlyOnceWith({
      chatId: "C1",
      userId: "U1",
      userName: "Alice",
      command: "help",
    });
  });

  it("surfaces both HTTP and Slack API failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({ ok: false, error: "invalid_auth" }),
      );
    vi.stubGlobal("fetch", fetch);
    const adapter = slack();
    await expect(adapter.sendMessage("C1", "one")).rejects.toThrow(
      "HTTP 403 - denied",
    );
    await expect(adapter.sendMessage("C1", "two")).rejects.toThrow(
      "invalid_auth",
    );
  });
});

describe("Discord gateway consumer behavior", () => {
  it("filters bots and channels, strips mentions, and carries member roles into commands", async () => {
    const adapter = discord();
    const message = vi.fn();
    const command = vi.fn();
    adapter.on("message", message);
    adapter.on("command", command);
    const base = {
      id: "m",
      channel_id: "1",
      guild_id: "guild",
      author: { id: "u", username: "Alice" },
      content: "<@123> <@!456> hello",
      attachments: [],
      member: { roles: ["moderator"] },
    };
    await adapter["handleDispatch"]("MESSAGE_CREATE", {
      ...base,
      author: { ...base.author, bot: true },
    });
    await adapter["handleDispatch"]("MESSAGE_CREATE", {
      ...base,
      channel_id: "2",
    });
    await adapter["handleDispatch"]("MESSAGE_CREATE", base);
    await adapter["handleDispatch"]("MESSAGE_CREATE", {
      ...base,
      content: "/whoami",
    });
    await adapter["handleDispatch"]("MESSAGE_CREATE", {
      ...base,
      guild_id: undefined,
      content: " ",
    });
    expect(message).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chatId: "channel:1",
        text: "hello",
        userName: "Alice",
        roleIds: ["moderator"],
      }),
    );
    expect(command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: "whoami", roleIds: ["moderator"] }),
    );
  });

  it("denies interactions ephemerally and acknowledges accepted commands before dispatch", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return Response.json({});
      }),
    );
    const adapter = discord();
    const command = vi.fn();
    adapter.on("command", command);
    const interaction = {
      id: "i",
      token: "token",
      type: 2,
      guild_id: "g",
      channel_id: "2",
      data: { name: "help" },
      member: { user: { id: "u", username: "Alice" }, roles: ["r"] },
    };
    await adapter["handleDispatch"]("INTERACTION_CREATE", interaction);
    expect(bodies).toEqual([
      {
        type: 4,
        data: {
          content: "This bot is not enabled in this channel.",
          flags: 64,
        },
      },
    ]);
    expect(command).not.toHaveBeenCalled();
    await adapter["handleDispatch"]("INTERACTION_CREATE", {
      ...interaction,
      channel_id: "1",
    });
    expect(bodies.at(-1)).toEqual({ type: 5 });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "channel:1",
        command: "help",
        userId: "u",
        roleIds: ["r"],
      }),
    );
  });

  it("sends authenticated replies, propagates delivery errors but treats typing as best effort", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "reply" }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const adapter = discord();
    await adapter.sendMessage("dm:1", "reply");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://discord.com/api/v10/channels/1/messages",
      expect.objectContaining({
        body: JSON.stringify({ content: "reply" }),
      }),
    );
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe("Bot secret");
    await expect(adapter.sendMessage("dm:1", "again")).rejects.toThrow(
      "HTTP 403",
    );
    await expect(adapter.sendTypingIndicator("dm:1")).resolves.toBeUndefined();
  });
});

describe("QQ delivery windows and inbound modes", () => {
  it("deduplicates full and mention events, reaccepts after TTL and rejects other chats", async () => {
    vi.useFakeTimers();
    const adapter = qq();
    const message = vi.fn();
    adapter.on("message", message);
    await adapter["handleDispatch"]("GROUP_MESSAGE_CREATE", qqMessage);
    await adapter["handleDispatch"]("GROUP_AT_MESSAGE_CREATE", qqMessage);
    await adapter["handleDispatch"]("GROUP_AT_MESSAGE_CREATE", {
      ...qqMessage,
      group_openid: "other",
    });
    expect(message).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chatId: "group:g",
        text: "hello",
        messageId: "m1",
        userId: "member",
      }),
    );
    vi.advanceTimersByTime(10_001);
    await adapter["handleDispatch"]("GROUP_AT_MESSAGE_CREATE", qqMessage);
    expect(message).toHaveBeenCalledTimes(2);
    const mentionAdapter = qq(true);
    const mentionMessage = vi.fn();
    mentionAdapter.on("message", mentionMessage);
    await mentionAdapter["handleDispatch"]("GROUP_MESSAGE_CREATE", qqMessage);
    expect(mentionMessage).not.toHaveBeenCalled();
    await mentionAdapter["handleDispatch"](
      "GROUP_AT_MESSAGE_CREATE",
      qqMessage,
    );
    expect(mentionMessage).toHaveBeenCalledOnce();
  });

  it("targets the exact inbound message, increments passive sequences and falls back after five replies or expiry", async () => {
    vi.useFakeTimers();
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("getAppAccessToken"))
        return Response.json({ access_token: "token", expires_in: 7200 });
      sends.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetch);
    const adapter = qq();
    await adapter["handleDispatch"]("GROUP_AT_MESSAGE_CREATE", qqMessage);
    await adapter["handleDispatch"]("GROUP_AT_MESSAGE_CREATE", {
      ...qqMessage,
      id: "newer",
    });
    for (let i = 0; i < 6; i++)
      await adapter.sendMessage("group:g", "answer", {
        replyToMessageId: "m1",
      });
    expect(
      sends.slice(0, 5).map((s) => [s.body.msg_id, s.body.msg_seq]),
    ).toEqual([
      ["m1", 1],
      ["m1", 2],
      ["m1", 3],
      ["m1", 4],
      ["m1", 5],
    ]);
    expect(sends[5]?.body).toEqual({
      markdown: { content: "answer" },
      msg_type: 2,
    });
    vi.advanceTimersByTime(300_001);
    await adapter.sendMessage("group:g", "late", { replyToMessageId: "newer" });
    expect(sends.at(-1)?.body).not.toHaveProperty("msg_id");
    expect(
      fetch.mock.calls.filter(([url]) => url.includes("getAppAccessToken")),
    ).toHaveLength(1);
    for (const [event, chat] of [
      ["C2C_MESSAGE_CREATE", "c2c:u"],
      ["AT_MESSAGE_CREATE", "channel:c"],
      ["DIRECT_MESSAGE_CREATE", "dm:d"],
    ] as const) {
      await adapter["handleDispatch"](event, qqMessage);
      await adapter.sendMessage(chat, "reply", { replyToMessageId: "m1" });
    }
    expect(sends.at(-3)?.url).toContain("/v2/users/u/messages");
    expect(sends.at(-2)?.body).toMatchObject({ msg_id: "m1" });
    expect(sends.at(-2)?.body).not.toHaveProperty("msg_seq");
    expect(sends.at(-1)?.url).toContain("/dms/d/messages");
    await expect(adapter.sendMessage("unknown:x", "bad")).rejects.toThrow(
      "Unknown chat type",
    );
  });

  it("retries public CDN attachments without credentials and rejects untrusted attachment hosts", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("getAppAccessToken"))
        return Response.json({ access_token: "token", expires_in: 7200 });
      if (new Headers(init?.headers).has("Authorization"))
        return new Response(null, { status: 403 });
      return new Response("file");
    });
    vi.stubGlobal("fetch", fetch);
    const adapter = qq();
    const message = vi.fn();
    adapter.on("message", message);
    await adapter["handleDispatch"]("C2C_MESSAGE_CREATE", {
      ...qqMessage,
      attachments: [
        {
          url: "https://gchat.qpic.cn/image",
          content_type: "image/png",
          size: 4,
        },
        { url: "https://localhost/private", filename: "secret" },
      ],
    });
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [
          {
            media_type: "image/png",
            data: Buffer.from("file").toString("base64"),
          },
        ],
      }),
    );
    expect(fetch.mock.calls.some(([url]) => url.includes("localhost"))).toBe(
      false,
    );
    expect(
      fetch.mock.calls.filter(([url]) => url.includes("qpic.cn")),
    ).toHaveLength(2);
  });
});

describe.each(["slack", "discord"] as const)(
  "%s streaming delivery",
  (platform) => {
    it("edits one response, keeps final text within platform limits, and starts a new response after completion", async () => {
      vi.useFakeTimers();
      const requests: Array<{
        url: string;
        body: Record<string, unknown>;
        method: string | undefined;
      }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          requests.push({
            url,
            body: JSON.parse(String(init.body)),
            method: init.method,
          });
          return Response.json({ ok: true, ts: "123", id: "123" });
        }),
      );
      const adapter = platform === "slack" ? slack() : discord();
      const chatId = platform === "slack" ? "C1" : "channel:1";
      const key = platform === "slack" ? "text" : "content";
      expect(await adapter.onStreamComplete(chatId, "nothing")).toBe(false);
      await adapter.onTextUpdate(chatId, "first");
      await adapter.onTextUpdate(chatId, "second");
      await vi.advanceTimersByTimeAsync(1500);
      expect(requests[0]?.body[key]).toBe("first");
      expect(requests.at(-1)?.body[key]).toBe("second");
      const limit = platform === "slack" ? 4000 : 2000;
      const finalText = "x".repeat(limit - 4) + "😀" + "tail";
      expect(await adapter.onStreamComplete(chatId, finalText)).toBe(true);
      const sent = String(requests.at(-1)?.body[key]);
      expect(sent.length).toBeLessThanOrEqual(limit);
      expect(sent.endsWith("...")).toBe(true);
      expect(sent).not.toMatch(/[\uD800-\uDBFF]\.\.\.$/);
      expect(await adapter.onStreamComplete(chatId, "again")).toBe(false);
      await adapter.onTextUpdate(chatId, "new response");
      await adapter.onStreamError(chatId, "failure");
      expect(String(requests.at(-1)?.body[key])).toContain("Error");
      expect(String(requests.at(-1)?.body[key])).toContain("failure");
      await adapter.disconnect();
    });

    it("allows ordinary-message fallback after creation or final edit failure", async () => {
      vi.useFakeTimers();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetch);
      const adapter = platform === "slack" ? slack() : discord();
      const chatId = platform === "slack" ? "C1" : "channel:1";
      await adapter.onTextUpdate(chatId, "partial");
      expect(await adapter.onStreamComplete(chatId, "final")).toBe(false);
      fetch.mockImplementation(async () =>
        Response.json({ ok: true, ts: "1", id: "1" }),
      );
      await adapter.onTextUpdate(chatId, "retry");
      fetch.mockImplementation(
        async () => new Response("unavailable", { status: 503 }),
      );
      expect(await adapter.onStreamComplete(chatId, "final retry")).toBe(false);
      fetch.mockImplementation(async () =>
        Response.json({ ok: true, ts: "2", id: "2" }),
      );
      await expect(
        adapter.sendMessage(chatId, "fallback reply"),
      ).resolves.toBeUndefined();
      await adapter.disconnect();
    });
  },
);
