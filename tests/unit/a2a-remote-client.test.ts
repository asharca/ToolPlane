// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Task, Message } from "@a2a-js/sdk";
import {
  discoverRemoteConnection,
  validateRemoteCard,
  remoteResult,
} from "@/lib/a2a/remote-client";
import { validateRemoteResponse } from "@/lib/a2a/remote-wire";
import {
  REMOTE_CARD,
  REMOTE_RPC,
  remoteCard,
  remoteTask,
} from "../fixtures/a2a-remote";
import type * as RemoteNetwork from "@/lib/a2a/remote-network";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/a2a/remote-network", async (original) => ({
  ...(await original<typeof RemoteNetwork>()),
  fetchRemoteJson: network.fetch,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    "TOOLPLANE_A2A_REMOTE_ORIGINS",
    JSON.stringify(["https://agent.example"]),
  );
  network.fetch.mockImplementation(async () => Response.json(remoteCard()));
});
afterEach(() => vi.unstubAllEnvs());
const request = { jsonrpc: "2.0", id: "request", method: "SendMessage" };
const response = (result: unknown) => ({
  jsonrpc: "2.0",
  id: "request",
  result,
});
describe("strict A2A 1.0 remote profile", () => {
  it("selects only the exact declared JSONRPC 1.0 interface", () => {
    const card = remoteCard();
    card.supportedInterfaces.push({
      url: "https://other.example/rpc",
      protocolVersion: "1.0",
      protocolBinding: "JSONRPC",
    });
    expect(
      validateRemoteCard(card, REMOTE_RPC, true).supportedInterfaces,
    ).toHaveLength(1);
    card.supportedInterfaces[0].protocolVersion = "0.3";
    expect(() => validateRemoteCard(card, REMOTE_RPC, true)).toThrow();
  });
  it("rejects undeclared targets, missing credentials and required extensions", () => {
    expect(() =>
      validateRemoteCard(remoteCard(), "https://other.example/rpc", true),
    ).toThrow();
    expect(() => validateRemoteCard(remoteCard(), REMOTE_RPC, false)).toThrow();
    expect(() =>
      validateRemoteCard(
        {
          ...remoteCard(),
          capabilities: {
            extensions: [{ uri: "https://extension.example", required: true }],
          },
        },
        REMOTE_RPC,
        true,
      ),
    ).toThrow();
  });
  it("does not treat OAuth or malformed oneofs as bearer authentication", () => {
    expect(() =>
      validateRemoteCard(
        {
          ...remoteCard(),
          securitySchemes: { service: { oauth2SecurityScheme: { flows: {} } } },
        },
        REMOTE_RPC,
        true,
      ),
    ).toThrow();
    expect(() =>
      validateRemoteCard(
        {
          ...remoteCard(),
          securitySchemes: {
            service: {
              httpAuthSecurityScheme: { scheme: "Bearer" },
              apiKeySecurityScheme: { name: "secret" },
            },
          },
        },
        REMOTE_RPC,
        true,
      ),
    ).toThrow();
  });
  it("accepts native task and direct message results without legacy kind fields", () => {
    expect(() =>
      validateRemoteResponse(request, response({ task: remoteTask() })),
    ).not.toThrow();
    const msg = {
      messageId: "peer-m",
      role: "ROLE_AGENT",
      parts: [{ text: "Immediate result" }],
    };
    expect(() =>
      validateRemoteResponse(request, response({ message: msg })),
    ).not.toThrow();
    expect(remoteResult(Message.fromJSON(msg))).toMatchObject({
      state: 3,
      text: "Immediate result",
    });
    expect(
      remoteResult(Task.fromJSON(remoteTask("TASK_STATE_COMPLETED"))),
    ).toMatchObject({
      state: 3,
      taskId: "peer-task",
      text: "Remote review result",
    });
  });
  it.each([
    { text: "ok", raw: "eA==" },
    { text: 17 },
    { url: "http://169.254.169.254" },
    { data: {} },
    { text: "<script>x</script>", mediaType: "text/html" },
    {},
  ])("rejects unsupported or lossy decoded parts", (part) => {
    expect(() =>
      validateRemoteResponse(
        request,
        response({
          message: { messageId: "m", role: "ROLE_AGENT", parts: [part] },
        }),
      ),
    ).toThrow();
  });
  it("rejects result oneof collisions, wrong IDs, unknown states and a legacy role", () => {
    expect(() =>
      validateRemoteResponse(
        request,
        response({ task: remoteTask(), message: {} }),
      ),
    ).toThrow();
    expect(() =>
      validateRemoteResponse(request, {
        ...response({ task: remoteTask() }),
        id: "other",
      }),
    ).toThrow();
    expect(() =>
      validateRemoteResponse(
        request,
        response({ task: remoteTask("working") }),
      ),
    ).toThrow();
    expect(() =>
      validateRemoteResponse(
        request,
        response({
          message: { messageId: "m", role: "agent", parts: [{ text: "x" }] },
        }),
      ),
    ).toThrow();
  });
  it("enforces total output size after standard decoding", () => {
    const task = remoteTask("TASK_STATE_COMPLETED");
    task.artifacts[0].parts[0].text = "x".repeat(65_537);
    expect(() => remoteResult(Task.fromJSON(task))).toThrow();
  });
});
describe("remote connection discovery", () => {
  it("discovers a single approved interface and forwards only the explicit peer credential", async () => {
    const signal = new AbortController().signal;
    const result = await discoverRemoteConnection(
      REMOTE_CARD,
      "peer-key",
      signal,
    );
    expect(result).toMatchObject({
      cardUrl: REMOTE_CARD,
      rpcUrl: REMOTE_RPC,
      card: { name: "Remote reviewer" },
    });
    expect(network.fetch).toHaveBeenCalledWith(
      REMOTE_CARD,
      "GET",
      undefined,
      "peer-key",
      signal,
    );
  });
  it("supports unauthenticated cards without requiring a token", async () => {
    network.fetch.mockResolvedValueOnce(
      Response.json({ ...remoteCard(), securityRequirements: [] }),
    );
    expect((await discoverRemoteConnection(REMOTE_CARD)).rpcUrl).toBe(
      REMOTE_RPC,
    );
  });
  it("requires an explicit declared RPC URL when compatible endpoints are ambiguous", async () => {
    const card = remoteCard(),
      second = "https://agent.example/advanced";
    card.supportedInterfaces.push({
      url: second,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    });
    network.fetch.mockImplementation(async () => Response.json(card));
    await expect(discoverRemoteConnection(REMOTE_CARD, "key")).rejects.toThrow(
      /advanced RPC URL/,
    );
    const selected = await discoverRemoteConnection(
      REMOTE_CARD,
      "key",
      undefined,
      second,
    );
    expect(selected.rpcUrl).toBe(second);
    expect(selected.card.supportedInterfaces.map(({ url }) => url)).toEqual([
      second,
    ]);
    await expect(
      discoverRemoteConnection(
        REMOTE_CARD,
        "key",
        undefined,
        "https://agent.example/undeclared",
      ),
    ).rejects.toThrow();
  });
  it.each([
    {
      url: "https://other.example/rpc",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
    { url: REMOTE_RPC, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    { url: REMOTE_RPC, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    {
      url: `${REMOTE_RPC}?secret=1`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ])(
    "rejects an unsafe or unsupported sole interface: $url $protocolVersion $protocolBinding",
    async (endpoint) => {
      network.fetch.mockResolvedValueOnce(
        Response.json({ ...remoteCard(), supportedInterfaces: [endpoint] }),
      );
      await expect(
        discoverRemoteConnection(REMOTE_CARD, "key"),
      ).rejects.toThrow();
    },
  );
  it("ignores incompatible or cross-origin alternatives rather than selecting them", async () => {
    const card = remoteCard();
    card.supportedInterfaces.push({
      url: "https://other.example/rpc",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    });
    network.fetch.mockResolvedValueOnce(Response.json(card));
    expect((await discoverRemoteConnection(REMOTE_CARD, "key")).rpcUrl).toBe(
      REMOTE_RPC,
    );
  });
  it("rejects missing authentication, disallowed origins and cross-origin advanced overrides", async () => {
    await expect(discoverRemoteConnection(REMOTE_CARD)).rejects.toThrow(
      /authentication/,
    );
    network.fetch.mockClear();
    await expect(
      discoverRemoteConnection("https://other.example/card", "key"),
    ).rejects.toThrow();
    await expect(
      discoverRemoteConnection(
        REMOTE_CARD,
        "key",
        undefined,
        "https://other.example/rpc",
      ),
    ).rejects.toThrow();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
