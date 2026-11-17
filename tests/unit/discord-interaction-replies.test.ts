import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelCommandEvent } from "@/lib/agents/channels/ChannelAdapter";
import { DiscordAdapter } from "@/lib/agents/channels/adapters/discord/DiscordAdapter";

function setup() {
  const adapter = new DiscordAdapter({
    channelId: "connection",
    agentId: "agent",
    channelType: "discord",
    channelConfig: { bot_token: "bot-secret" },
  });
  const events: ChannelCommandEvent[] = [];
  adapter.on("command", (event) => events.push(event));
  // Drive the same dispatch handler as Gateway without opening a platform socket.
  const handler: unknown = Reflect.get(adapter, "handleDispatch");
  if (typeof handler !== "function")
    throw new Error("Missing dispatch handler");
  const receive = (id: string, name: string, component = false) =>
    handler.call(adapter, "INTERACTION_CREATE", {
      id,
      application_id: "app",
      token: `secret-${id}`,
      type: component ? 3 : 2,
      channel_id: "42",
      guild_id: "7",
      channel: { type: 11 },
      member: { user: { id: "user", username: "user" }, roles: [] },
      data: component ? { custom_id: "tp:upgrade:abcdef" } : { name },
    });
  return { adapter, events, receive };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord deferred command replies", () => {
  it("finishes the matching interaction for concurrent status and permission-denied replies", async () => {
    const { adapter, events, receive } = setup();
    const pending = new Map<string, string | null>();
    const messages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        const body = JSON.parse(String(init.body));
        if (url.pathname.endsWith("/callback")) {
          pending.set(url.pathname.split("/")[4], null);
          return new Response(null, { status: 204 });
        }
        if (
          init.method === "PATCH" &&
          url.pathname.endsWith("/messages/@original")
        ) {
          expect(new Headers(init.headers).has("authorization")).toBe(false);
          const id = url.pathname.split("/")[5].replace("secret-", "");
          pending.set(id, body.content);
        } else messages.push(body.content);
        return Response.json({ id: "reply" });
      }),
    );
    await receive("one", "status");
    await receive("two", "upgrade");
    await expect(
      adapter.sendMessage("channel:other", "Wrong destination", {
        replyToMessageId: "one",
      }),
    ).rejects.toThrow(/channel mismatch/);
    expect(events.map((e) => e.messageId)).toEqual(["one", "two"]);
    await adapter.sendMessage("channel:42", "Requires a channel admin", {
      replyToMessageId: "two",
    });
    await adapter.sendMessage("channel:42", "Revision v10", {
      replyToMessageId: "one",
    });
    expect([...pending.entries()]).toEqual([
      ["one", "Revision v10"],
      ["two", "Requires a channel admin"],
    ]);
    expect(messages).toEqual([]);
    await adapter.sendMessage("channel:42", "Ordinary chat", {
      replyToMessageId: "message",
    });
    expect(messages).toEqual(["Ordinary chat"]);
    await receive("three", "status");
    await adapter.sendPendingReply("channel:42", "Access denied", {
      replyToMessageId: "three",
    });
    expect(pending.get("three")).toBe("Access denied");
    await adapter.sendPendingReply("channel:42", "Ignored ordinary message", {
      replyToMessageId: "ordinary",
    });
    expect(messages).toEqual(["Ordinary chat"]);
    await adapter.disconnect();
  });

  it("keeps confirmation buttons on the original response and updates it after a component confirmation", async () => {
    const { adapter, receive } = setup();
    const updates: Array<{ content: string; components: unknown[] }> = [];
    const overflow: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (input.endsWith("/callback"))
          return new Response(null, { status: 204 });
        if (init.method === "PATCH") updates.push(body);
        else overflow.push(body.content);
        return Response.json({ id: "reply" });
      }),
    );
    await receive("one", "upgrade");
    await adapter.sendMessage("channel:42", "Confirm upgrade", {
      replyToMessageId: "one",
      confirmation: { command: "upgrade", token: "abcdef" },
    });
    expect(updates[0]).toMatchObject({
      content: "Confirm upgrade",
      components: [{ components: [{ custom_id: "tp:upgrade:abcdef" }] }],
    });
    await receive("two", "upgrade", true);
    await adapter.sendMessage("channel:42", "x".repeat(2500), {
      replyToMessageId: "two",
    });
    expect(updates[1].components).toEqual([]);
    expect(updates[1].content + overflow.join("")).toBe("x".repeat(2500));
    expect(updates[1].content.length).toBeLessThanOrEqual(2000);
    await adapter.disconnect();
  });

  it("does not execute a command whose interaction acknowledgement failed", async () => {
    const { adapter, events, receive } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-one", { status: 401 })),
    );
    await expect(receive("one", "upgrade")).rejects.toThrow(/HTTP 401/);
    expect(events).toEqual([]);
    await adapter.disconnect();
  });

  it("surfaces failed interaction delivery without leaking its capability or posting a misleading new reply", async () => {
    const { adapter, receive } = setup();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        if (input.endsWith("/callback"))
          return new Response(null, { status: 204 });
        if (init.method !== "PATCH") posts.push(input);
        return new Response("secret-one", { status: 403 });
      }),
    );
    await receive("one", "status");
    const failure = adapter.sendMessage("channel:42", "Status", {
      replyToMessageId: "one",
    });
    await expect(failure).rejects.toThrow(/HTTP 403/);
    await expect(failure).rejects.not.toThrow(/secret-one/);
    expect(posts).toEqual([]);
    await adapter.disconnect();
  });
});

describe("Discord streamed replies", () => {
  it("keeps live progress within one message and delivers the full final reply", async () => {
    const { adapter } = setup();
    const posted: string[] = [];
    const edited: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        if (init.method === "PATCH") edited.push(body.content);
        else posted.push(body.content);
        return Response.json({ id: "streamed" });
      }),
    );
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => `line-${i}`).join("\n");
    const progress = lines(400);
    await adapter.onTextUpdate("channel:42", progress);
    // Progress shows its latest part, not a frozen first page.
    expect(posted).toHaveLength(1);
    expect(posted[0].length).toBeLessThanOrEqual(2000);
    expect(posted[0]).toContain("line-399");
    const final = lines(700);
    expect(await adapter.onStreamComplete("channel:42", final)).toBe(true);
    const delivered = [edited.at(-1) ?? "", ...posted.slice(1)];
    expect(delivered.every((text) => text.length <= 2000)).toBe(true);
    const shown = delivered.join("\n").split("\n");
    for (let i = 0; i < 700; i++) expect(shown).toContain(`line-${i}`);
  });
});
