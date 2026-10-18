// @vitest-environment node
import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { SlackAdapter } from "@/lib/agents/channels/adapters/slack/SlackAdapter";
import { DiscordAdapter } from "@/lib/agents/channels/adapters/discord/DiscordAdapter";
import { QqAdapter } from "@/lib/agents/channels/adapters/qq/QqAdapter";

const network = vi.hoisted(() => ({
  sockets: [] as Array<
    EventEmitter & { readyState: number; send: Mock; close: Mock; ping: Mock }
  >,
}));
vi.mock("ws", async () => {
  const { EventEmitter: Emitter } = await vi.importActual<{
    EventEmitter: typeof EventEmitter;
  }>("node:events");
  return {
    default: class extends Emitter {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      send = vi.fn();
      ping = vi.fn();
      close = vi.fn((code = 1000, reason = "") => {
        this.readyState = 3;
        this.emit("close", code, Buffer.from(reason));
      });
      constructor(readonly url: string) {
        super();
        network.sockets.push(this);
      }
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  network.sockets = [];
});

describe.each(["slack", "discord", "qq"] as const)(
  "%s gateway lifecycle",
  (platform) => {
    it("authenticates the handshake, exposes readiness only after the server greeting, and reconnects after transport loss", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("auth.test"))
            return Response.json({ ok: true, user_id: "bot" });
          if (url.endsWith("apps.connections.open"))
            return Response.json({
              ok: true,
              url: "wss://wss-primary.slack.com/socket",
            });
          if (url.endsWith("getAppAccessToken"))
            return Response.json({
              access_token: "qq-token",
              expires_in: 7200,
            });
          if (url.endsWith("gateway/bot"))
            return Response.json({ url: "wss://gateway.discord.gg" });
          if (url.endsWith("/gateway"))
            return Response.json({ url: "wss://api.sgroup.qq.com/websocket" });
          return Response.json({ ok: true });
        }),
      );
      const adapter =
        platform === "slack"
          ? new SlackAdapter({
              channelId: "s",
              agentId: "a",
              channelType: "slack",
              channelConfig: { bot_token: "token", app_token: "app" },
            })
          : platform === "discord"
            ? new DiscordAdapter({
                channelId: "d",
                agentId: "a",
                channelType: "discord",
                channelConfig: { bot_token: "token" },
              })
            : new QqAdapter({
                channelId: "q",
                agentId: "a",
                channelType: "qq",
                channelConfig: { app_id: "app", client_secret: "secret" },
              });
      async function handleGatewayPacket(packet: Buffer) {
        if (adapter instanceof DiscordAdapter)
          await adapter["handleWsMessage"](packet);
        else if (adapter instanceof QqAdapter)
          await adapter["handleWsMessage"](packet);
        else throw new Error("Slack does not use the gateway protocol");
      }
      const status = vi.fn();
      adapter.on("statusChange", status);
      await adapter.connect();
      expect(adapter.connected).toBe(false);
      const socket = network.sockets[0];
      if (!socket) throw new Error("Missing gateway connection");
      socket.emit("open");
      socket.emit("error", new Error("temporary transport warning"));
      if (adapter instanceof SlackAdapter) {
        await adapter["handleSocketMessage"](
          Buffer.from(JSON.stringify({ type: "hello", envelope_id: "e" })),
        );
        expect(socket.send).toHaveBeenCalledWith(
          JSON.stringify({ envelope_id: "e" }),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        expect(socket.ping).toHaveBeenCalledOnce();
      } else {
        await handleGatewayPacket(
          Buffer.from(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }),
          ),
        );
        expect(socket.send).toHaveBeenCalledWith(
          expect.stringContaining('"op":2'),
        );
        const identify = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
        expect(identify.d.token).toBe(
          platform === "qq" ? "QQBot qq-token" : "token",
        );
        await handleGatewayPacket(
          Buffer.from(
            JSON.stringify({
              op: 0,
              t: "READY",
              s: 42,
              d: {
                session_id: "session",
                resume_gateway_url: "wss://gateway.discord.gg",
                user: { id: "bot", username: "Test" },
                application: { id: "app" },
              },
            }),
          ),
        );
        await vi.advanceTimersByTimeAsync(600);
        if (adapter instanceof DiscordAdapter)
          expect(socket.send).toHaveBeenCalledWith(
            JSON.stringify({ op: 1, d: 42 }),
          );
      }
      expect(adapter.connected).toBe(true);
      expect(status).toHaveBeenCalledWith({ connected: true });
      socket.close(1006, "network lost");
      expect(adapter.connected).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(network.sockets).toHaveLength(2);
      const replacement = network.sockets[1];
      if (!replacement) throw new Error("Missing replacement connection");
      if (!(adapter instanceof SlackAdapter)) {
        await handleGatewayPacket(
          Buffer.from(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }),
          ),
        );
        expect(replacement.send).toHaveBeenCalledWith(
          expect.stringContaining('"op":6'),
        );
        const resume = JSON.parse(String(replacement.send.mock.calls[0]?.[0]));
        expect(resume.d).toMatchObject({ session_id: "session", seq: 42 });
        await handleGatewayPacket(
          Buffer.from(JSON.stringify({ op: 0, t: "RESUMED", d: {} })),
        );
        expect(adapter.connected).toBe(true);
      }
      await adapter.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(network.sockets).toHaveLength(2);
      expect(adapter.connected).toBe(false);
    });
  },
);

it("does not reconnect Discord after authentication is rejected", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ url: "wss://gateway.discord.gg" })),
  );
  const adapter = new DiscordAdapter({
    channelId: "d",
    agentId: "a",
    channelType: "discord",
    channelConfig: { bot_token: "invalid" },
  });
  await adapter.connect();
  network.sockets[0]?.close(4004, "invalid token");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(network.sockets).toHaveLength(1);
  expect(adapter.connected).toBe(false);
  await adapter.disconnect();
});

describe.each(["slack", "discord", "qq"] as const)(
  "%s recovery boundaries",
  (platform) => {
    it.each(["http", "provider", "untyped"])(
      "retries %s handshake failures and cancels pending retry on disconnect",
      async (failure) => {
        vi.useFakeTimers();
        let attempts = 0;
        const fetch = vi.fn(async (url: string) => {
          if (url.endsWith("auth.test")) return Response.json({ ok: false });
          if (url.endsWith("getAppAccessToken")) {
            if (attempts === 0 && failure === "provider") {
              attempts++;
              return Response.json({});
            }
            return Response.json({ access_token: "token", expires_in: 7200 });
          }
          attempts++;
          if (attempts === 1) {
            if (failure === "untyped") throw "network down";
            if (failure === "http")
              return new Response("down", { status: 503 });
            return Response.json({ ok: false, error: "not ready" });
          }
          return Response.json(
            platform === "slack"
              ? { ok: true, url: "wss://wss-primary.slack.com/socket" }
              : {
                  url:
                    platform === "qq"
                      ? "wss://api.sgroup.qq.com/websocket"
                      : "wss://gateway.discord.gg",
                },
          );
        });
        vi.stubGlobal("fetch", fetch);
        const adapter =
          platform === "slack"
            ? new SlackAdapter({
                channelId: "s",
                agentId: "a",
                channelType: "slack",
                channelConfig: { bot_token: "token", app_token: "app" },
              })
            : platform === "discord"
              ? new DiscordAdapter({
                  channelId: "d",
                  agentId: "a",
                  channelType: "discord",
                  channelConfig: { bot_token: "token" },
                })
              : new QqAdapter({
                  channelId: "q",
                  agentId: "a",
                  channelType: "qq",
                  channelConfig: { app_id: "app", client_secret: "secret" },
                });
        await adapter.connect();
        expect(adapter.connected).toBe(false);
        expect(network.sockets).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(network.sockets).toHaveLength(1);
        network.sockets[0]?.close(1006, "temporary");
        await adapter.disconnect();
        const calls = fetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetch).toHaveBeenCalledTimes(calls);
      },
    );
  },
);

it.each([true, false])(
  "Discord invalid session resumable=%s preserves or replaces identity",
  async (resumable) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ url: "wss://gateway.discord.gg" })),
    );
    const adapter = new DiscordAdapter({
      channelId: "d",
      agentId: "a",
      channelType: "discord",
      channelConfig: { bot_token: "token" },
    });
    await adapter.connect();
    const socket = network.sockets[0];
    if (!socket) throw new Error("Gateway socket missing");
    await adapter["handleWsMessage"](
      Buffer.from(
        JSON.stringify({
          op: 0,
          t: "READY",
          s: 4,
          d: {
            session_id: "session",
            resume_gateway_url: "wss://gateway.discord.gg",
            user: { id: "bot", username: "Bot" },
            application: { id: "app" },
          },
        }),
      ),
    );
    const invalid = adapter["handleWsMessage"](
      Buffer.from(JSON.stringify({ op: 9, d: resumable })),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await invalid;
    expect(socket.send).toHaveBeenLastCalledWith(
      expect.stringContaining(resumable ? '"op":6' : '"op":2'),
    );
    await adapter["handleWsMessage"](Buffer.from("invalid"));
    await adapter["handleWsMessage"](Buffer.from(JSON.stringify({ op: 0 })));
    await adapter["handleWsMessage"](Buffer.from(JSON.stringify({ op: 11 })));
    await adapter["handleWsMessage"](Buffer.from(JSON.stringify({ op: 1 })));
    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({ op: 1, d: resumable ? 4 : null }),
    );
    await adapter["handleWsMessage"](Buffer.from(JSON.stringify({ op: 7 })));
    expect(socket.close).toHaveBeenCalledWith(4000, "Reconnect requested");
    await adapter.disconnect();
  },
);

it("Discord missing heartbeat acknowledgement forces reconnect rather than leaving a half-open connection", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ url: "wss://gateway.discord.gg" })),
  );
  const adapter = new DiscordAdapter({
    channelId: "d",
    agentId: "a",
    channelType: "discord",
    channelConfig: { bot_token: "token" },
  });
  await adapter.connect();
  await adapter["handleWsMessage"](
    Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } })),
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(network.sockets[0]?.close).toHaveBeenCalledWith(
    4000,
    "Heartbeat timeout",
  );
  await adapter.disconnect();
});
