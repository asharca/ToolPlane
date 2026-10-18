// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ connection: vi.fn(), message: vi.fn() }));
vi.mock("@/lib/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("@/lib/agents/channel-connections", () => ({
  findAgentChannelByInboundToken: m.connection,
}));
vi.mock("@/lib/agents/message-service", () => ({
  runAgentChannelMessage: m.message,
}));
import {
  GET,
  POST,
} from "@/app/api/v1/agent-channels/[connectionId]/events/route";
const context = { params: Promise.resolve({ connectionId: "connection" }) };
const post = (body: unknown, token = "secret") =>
  new Request("http://localhost/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.connection.mockResolvedValue({
    platform: "slack",
    workspaceId: "workspace",
    agentId: "agent",
  });
  m.message.mockResolvedValue({
    status: 202,
    body: { accepted: true, messageId: "message" },
  });
});
describe("channel inbound events", () => {
  it("requires connection-bound inbound tokens and never dispatches unauthorized events", async () => {
    expect(
      (await GET(new Request("http://localhost/events"), context)).status,
    ).toBe(401);
    expect(m.connection).not.toHaveBeenCalled();
    m.connection.mockResolvedValue(null);
    expect((await POST(post({ text: "hello" }, "wrong"), context)).status).toBe(
      401,
    );
    expect(m.connection).toHaveBeenCalledWith("connection", "wrong");
    expect(m.message).not.toHaveBeenCalled();
  });
  it.each<[string, Record<string, string>, string]>([
    [
      "http://localhost/events",
      { authorization: "bEaReR  bearer-secret " },
      "bearer-secret",
    ],
    [
      "http://localhost/events",
      { "x-toolplane-channel-token": "header-secret" },
      "header-secret",
    ],
    ["http://localhost/events?token=query-secret", {}, "query-secret"],
    ["http://localhost/events?access_token=legacy-secret", {}, "legacy-secret"],
    [
      "http://localhost/events?token=fallback",
      { authorization: "Bearer " },
      "fallback",
    ],
  ])(
    "accepts supported callback credentials: %s",
    async (url, headers, token) => {
      expect((await GET(new Request(url, { headers }), context)).status).toBe(
        200,
      );
      expect(m.connection).toHaveBeenCalledWith("connection", token);
    },
  );
  it("rejects unsupported platforms for both challenge and message requests", async () => {
    m.connection.mockResolvedValue({ platform: "missing" });
    expect(
      (await GET(new Request("http://localhost?token=secret"), context)).status,
    ).toBe(404);
    expect((await POST(post({}), context)).status).toBe(404);
    expect(m.message).not.toHaveBeenCalled();
  });
  it.each(["hub.challenge", "challenge", "echostr"])(
    "returns %s callback challenges as plain text",
    async (key) => {
      const response = await GET(
        new Request(`http://localhost?token=secret&${key}=verify-me`),
        context,
      );
      expect(await response.text()).toBe("verify-me");
      expect(response.headers.get("content-type")).toBe("text/plain");
    },
  );
  it("describes callback versus hosted-runner delivery mode", async () => {
    expect(
      await (
        await GET(new Request("http://localhost?token=secret"), context)
      ).json(),
    ).toMatchObject({
      connectionId: "connection",
      agentId: "agent",
      platform: "slack",
      mode: "hosted-runner",
    });
    m.connection.mockResolvedValue({
      platform: "google_chat",
      workspaceId: "workspace",
      agentId: "agent",
    });
    expect(
      await (
        await GET(new Request("http://localhost?token=secret"), context)
      ).json(),
    ).toMatchObject({ platform: "google_chat", mode: "callback" });
  });
  it("rejects malformed JSON and handles Slack verification without running the agent", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost?token=secret", {
            method: "POST",
            body: "{",
          }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      await (
        await POST(
          post({ type: "url_verification", challenge: "verify" }),
          context,
        )
      ).json(),
    ).toEqual({ challenge: "verify" });
    expect(m.message).not.toHaveBeenCalled();
  });
  it("normalizes real Slack event payloads and returns the delivery outcome", async () => {
    const response = await POST(
      post({
        team_id: "team",
        event: {
          text: "Ship release",
          channel: "channel",
          user: "sender",
          ts: "123",
          thread_ts: "100",
        },
      }),
      context,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      messageId: "message",
      connectionId: "connection",
      platform: "slack",
    });
    expect(m.message).toHaveBeenCalledWith({
      connectionId: "connection",
      workspaceId: "workspace",
      agentId: "agent",
      rawBody: expect.objectContaining({
        message: "Ship release",
        source: expect.objectContaining({
          platform: "slack",
          chatId: "channel",
          userId: "sender",
          threadId: "100",
          messageId: "123",
          scopeId: "team",
        }),
      }),
    });
  });
  it("handles non-object events and verification-shaped messages without a string challenge as normal messages", async () => {
    for (const body of [
      null,
      "text",
      { type: "url_verification", challenge: 123 },
    ])
      expect((await POST(post(body), context)).status).toBe(202);
    expect(m.message).toHaveBeenCalledTimes(3);
  });
  it("uses Telegram identities and preserves service failure responses", async () => {
    m.connection.mockResolvedValue({
      platform: "telegram",
      workspaceId: "workspace",
      agentId: "agent",
    });
    m.message.mockResolvedValue({
      status: 409,
      body: { error: "Connection paused" },
    });
    const response = await POST(
      post({
        message: {
          text: "hello",
          message_id: 42,
          chat: { id: 99, type: "private" },
          from: { id: 7 },
        },
      }),
      context,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Connection paused",
      connectionId: "connection",
      platform: "telegram",
    });
    expect(m.message).toHaveBeenCalledWith(
      expect.objectContaining({
        rawBody: expect.objectContaining({
          message: "hello",
          source: expect.objectContaining({
            platform: "telegram",
            chatId: "99",
            userId: "7",
            messageId: "42",
            chatType: "dm",
          }),
        }),
      }),
    );
  });
});
