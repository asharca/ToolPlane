// @vitest-environment node
import WebSocket from "ws";
import type { ClientOptions } from "ws";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CONNECTOR_PROTOCOL_VERSION } from "@/lib/sandboxes/connector";

const mocks = vi.hoisted(() => ({ findSandboxByConnectorToken: vi.fn() }));

vi.mock("@/lib/sandboxes/connector-auth", () => ({
  findSandboxByConnectorToken: mocks.findSandboxByConnectorToken,
}));
vi.mock("@/lib/observability/system", () => ({ systemLog: vi.fn() }));

let broker: typeof import("@/lib/sandboxes/connector-broker");
let wsUrl = "";
let publicWsUrl: string | undefined;

function sandboxRecord() {
  return {
    id: "sb-broker",
    workspaceId: "ws-broker",
    deploymentId: "dep-broker",
    name: "Broker integration",
    slug: "broker-integration",
    connector: {},
  };
}

async function openConnector(token = "mcpcon_broker_test"): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function openSocket(
  url: string,
  options?: ClientOptions,
): Promise<WebSocket> {
  const ws = new WebSocket(url, options);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readyConnector() {
  const ws = await openConnector();
  ws.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      capabilities: ["process_exec", "write_file_base64"],
      displays: [{ id: "desktop", transport: "rfb" }],
    }),
  );
  await waitFor(() => broker.connectorStatus("sb-broker").connected);
  return ws;
}

describe("connector broker integration", () => {
  beforeAll(async () => {
    publicWsUrl = process.env.CONNECTOR_WS_PUBLIC_URL;
    delete process.env.CONNECTOR_WS_PUBLIC_URL;
    process.env.CONNECTOR_WS_BIND = "127.0.0.1";
    process.env.CONNECTOR_WS_PORT = "0";
    broker = await import("@/lib/sandboxes/connector-broker");
    const started = await broker.ensureConnectorBroker();
    wsUrl = `ws://127.0.0.1:${started.port}/connect`;
  });

  afterAll(async () => {
    await broker.shutdownConnectorBroker();
    delete process.env.CONNECTOR_WS_BIND;
    delete process.env.CONNECTOR_WS_PORT;
    if (publicWsUrl === undefined) delete process.env.CONNECTOR_WS_PUBLIC_URL;
    else process.env.CONNECTOR_WS_PUBLIC_URL = publicWsUrl;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSandboxByConnectorToken.mockImplementation(
      async (token: string) =>
        token === "mcpcon_broker_test" ? sandboxRecord() : null,
    );
    broker.disconnectConnector("sb-broker", "test reset");
  });

  it("authenticates a Bearer WebSocket, negotiates v2 capabilities, and proxies a request", async () => {
    const ws = await openConnector();
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        op?: string;
      };
      if (message.type === "request" && message.op === "ping") {
        ws.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: true,
            result: { ok: true },
          }),
        );
      }
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        version: "0.1.9",
        root: "C:\\Users\\Ada\\ToolPlane",
        platform: "win32",
        arch: "x64",
        shell: "powershell.exe",
        shellFamily: "powershell",
        nodeVersion: "20.0.0",
        capabilities: ["process_exec", "write_file_base64"],
      }),
    );
    await waitFor(() => broker.connectorStatus("sb-broker").connected);

    const started = await broker.ensureConnectorBroker();
    const response = await fetch(
      `${started.internalUrl}/internal/connectors/sb-broker/request`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-connector-broker-token": started.internalToken,
        },
        body: JSON.stringify({ op: "ping", args: {}, timeoutMs: 1000 }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: { ok: true } });
    expect(broker.connectorStatus("sb-broker")).toMatchObject({
      connected: true,
      platform: "win32",
      root: "C:\\Users\\Ada\\ToolPlane",
    });
    expect(mocks.findSandboxByConnectorToken).toHaveBeenCalledWith(
      "mcpcon_broker_test",
    );
    ws.close();
  });

  it("revokes an authenticated socket even when hello is delayed", async () => {
    const ws = await openConnector();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

    broker.disconnectConnector("sb-broker", "connector token rotated");

    await expect(closed).resolves.toEqual({
      code: 4001,
      reason: "connector token rotated",
    });
    expect(broker.connectorStatus("sb-broker").connected).toBe(false);
  });

  it("revalidates the credential when hello arrives after the upgrade", async () => {
    mocks.findSandboxByConnectorToken
      .mockResolvedValueOnce(sandboxRecord())
      .mockResolvedValueOnce(null);
    const ws = await openConnector();
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));

    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        capabilities: ["process_exec", "write_file_base64"],
      }),
    );

    await expect(closed).resolves.toBe(4001);
    expect(mocks.findSandboxByConnectorToken).toHaveBeenCalledTimes(2);
    expect(broker.connectorStatus("sb-broker").connected).toBe(false);
  });

  it("rejects query-string auth and incompatible capabilities", async () => {
    const queryOnly = new WebSocket(`${wsUrl}?token=mcpcon_broker_test`);
    await expect(
      new Promise<void>((resolve, reject) => {
        queryOnly.once("open", resolve);
        queryOnly.once("error", reject);
      }),
    ).rejects.toThrow(/401/);

    const incompatible = await openConnector();
    const closed = new Promise<number>((resolve) =>
      incompatible.once("close", resolve),
    );
    incompatible.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        capabilities: ["process_exec"],
      }),
    );
    await expect(closed).resolves.toBe(4002);
    expect(broker.connectorStatus("sb-broker").connected).toBe(false);
  });

  it("publishes sanitized display metadata and captures a bounded snapshot", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ws = await openConnector();
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        op?: string;
      };
      if (message.type === "request" && message.op === "screen_capture") {
        ws.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: true,
            result: { data: png.toString("base64"), contentType: "image/png" },
          }),
        );
      }
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        capabilities: ["process_exec", "write_file_base64"],
        device: { kind: "ANDROID", name: " Pixel 9 " },
        displays: [
          {
            id: "main",
            label: "Phone",
            transport: "snapshot",
            control: false,
            width: 1080,
            height: 2400,
          },
          { id: "ignored", label: "Ignored", transport: "video" },
        ],
      }),
    );
    await waitFor(() => broker.connectorStatus("sb-broker").connected);

    expect(broker.connectorStatus("sb-broker")).toMatchObject({
      device: { kind: "android", name: "Pixel 9" },
      displays: [
        {
          id: "main",
          label: "Phone",
          transport: "snapshot",
          control: false,
          width: 1080,
          height: 2400,
        },
      ],
    });
    await expect(
      broker.captureConnectorScreen("sb-broker", "main"),
    ).resolves.toEqual({
      data: png,
      contentType: "image/png",
    });
    await expect(
      broker.captureConnectorScreen("sb-broker", "ignored"),
    ).rejects.toThrow(/does not support snapshot/);
    ws.close();
  });

  it("relays RFB through one-time tickets, replaces the display session, and clears on disconnect", async () => {
    const connector = await openConnector();
    let source: WebSocket | undefined;
    connector.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        op?: string;
        args?: { sourceUrl?: string };
      };
      if (
        message.type !== "request" ||
        message.op !== "screen_open" ||
        !message.args?.sourceUrl
      )
        return;
      source = new WebSocket(message.args.sourceUrl, {
        headers: { authorization: "Bearer mcpcon_broker_test" },
      });
      source.once("open", () =>
        connector.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: true,
            result: { ok: true },
          }),
        ),
      );
    });
    connector.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        capabilities: ["process_exec", "write_file_base64"],
        displays: [
          { id: "vnc", label: "Screen", transport: "rfb", control: true },
        ],
      }),
    );
    await waitFor(() => broker.connectorStatus("sb-broker").connected);

    const session = await broker.createConnectorScreenSession(
      "sb-broker",
      "vnc",
      "http://127.0.0.1",
    );
    const viewer = await openSocket(session.viewerUrl);
    await waitFor(() => source?.readyState === WebSocket.OPEN);

    const fromSource = new Promise<Buffer>((resolve) =>
      viewer.once("message", (raw) => resolve(Buffer.from(raw as Buffer))),
    );
    source?.send(Buffer.from("RFB 003.008\n"));
    await expect(fromSource).resolves.toEqual(Buffer.from("RFB 003.008\n"));

    const fromViewer = new Promise<Buffer>((resolve) =>
      source?.once("message", (raw) => resolve(Buffer.from(raw as Buffer))),
    );
    viewer.send(Buffer.from([1, 2, 3]));
    await expect(fromViewer).resolves.toEqual(Buffer.from([1, 2, 3]));

    await expect(openSocket(session.viewerUrl)).rejects.toThrow(/401/);
    const firstViewerClosed = new Promise<void>((resolve) =>
      viewer.once("close", () => resolve()),
    );
    const replacement = await broker.createConnectorScreenSession(
      "sb-broker",
      "vnc",
      "http://127.0.0.1",
    );
    await firstViewerClosed;
    const replacementViewer = await openSocket(replacement.viewerUrl);
    await waitFor(() => source?.readyState === WebSocket.OPEN);

    const viewerClosed = new Promise<void>((resolve) =>
      replacementViewer.once("close", () => resolve()),
    );
    broker.disconnectConnector("sb-broker", "token rotated");
    await viewerClosed;
  });
  it("protects internal routes and reports disconnected requests without leaking transport failures", async () => {
    const started = await broker.ensureConnectorBroker();
    const health = await fetch(`${started.internalUrl}/health`);
    expect(await health.json()).toEqual({
      status: "ok",
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    });
    expect((await fetch(`${started.internalUrl}/missing`)).status).toBe(404);
    expect(
      (
        await fetch(
          `${started.internalUrl}/internal/connectors/sb-broker/request`,
          { method: "POST", body: "{}" },
        )
      ).status,
    ).toBe(401);
    const headers = { "x-connector-broker-token": started.internalToken };
    expect(
      (await fetch(`${started.internalUrl}/internal/missing`, { headers }))
        .status,
    ).toBe(404);
    for (const body of [
      "not-json",
      "[]",
      "null",
      JSON.stringify({ op: "ping" }),
    ]) {
      const response = await fetch(
        `${started.internalUrl}/internal/connectors/sb-broker/request`,
        { method: "POST", headers, body },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toHaveProperty("error");
    }
  });

  it.each([
    [null, "invalid screen frame"],
    [{ data: "", contentType: "image/png" }, "invalid screen frame"],
    [{ data: "%%%", contentType: "image/png" }, "invalid screen frame"],
    [{ data: 42, contentType: "image/png" }, "invalid screen frame"],
    [
      { data: "aGVsbG8=", contentType: "text/html" },
      "unsupported screen frame type",
    ],
  ])("rejects untrusted screen frame payloads", async (result, message) => {
    const ws = await openConnector();
    ws.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.type === "request")
        ws.send(JSON.stringify({ type: "response", id: request.id, result }));
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        capabilities: ["process_exec", "write_file_base64"],
        displays: [{ id: "main", transport: "snapshot" }],
      }),
    );
    await waitFor(() => broker.connectorStatus("sb-broker").connected);
    await expect(
      broker.captureConnectorScreen("sb-broker", "main"),
    ).rejects.toThrow(message);
    ws.close();
  });

  it("normalizes metadata, ignores duplicate hello and propagates connector rejection", async () => {
    const ws = await openConnector();
    ws.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.type === "request")
        ws.send(
          JSON.stringify({
            type: "response",
            id: request.id,
            ok: false,
            error: "permission denied",
          }),
        );
    });
    ws.send("not-json");
    ws.send(JSON.stringify({ type: "response", id: "unsolicited" }));
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        capabilities: [42, "process_exec", "write_file_base64"],
        root: "   ",
        device: { kind: "invalid kind" },
        displays: [
          null,
          42,
          {
            id: "main",
            name: "Named screen",
            transport: "snapshot",
            width: -1,
            height: 32769,
          },
          { id: "main", transport: "rfb" },
          { id: "fallback", transport: "rfb", width: 800, height: 600 },
          { id: "", transport: "snapshot" },
        ],
      }),
    );
    await waitFor(() => broker.connectorStatus("sb-broker").connected);
    expect(broker.connectorStatus("sb-broker")).toMatchObject({
      root: null,
      device: null,
      displays: [
        {
          id: "main",
          label: "Named screen",
          transport: "snapshot",
          control: false,
          width: null,
          height: null,
        },
        {
          id: "fallback",
          label: "fallback",
          transport: "rfb",
          control: false,
          width: 800,
          height: 600,
        },
      ],
    });
    ws.send(JSON.stringify({ type: "hello", protocolVersion: 0 }));
    await expect(
      broker.captureConnectorScreen("sb-broker", "main"),
    ).rejects.toThrow("permission denied");
    expect(broker.connectorStatus("sb-broker").connected).toBe(true);
    ws.close();
  });

  it("times out unanswered requests and rejects pending operations on disconnect", async () => {
    const ws = await openConnector();
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        capabilities: ["process_exec", "write_file_base64"],
      }),
    );
    await waitFor(() => broker.connectorStatus("sb-broker").connected);
    const started = await broker.ensureConnectorBroker();
    const response = await fetch(
      `${started.internalUrl}/internal/connectors/sb-broker/request`,
      {
        method: "POST",
        headers: { "x-connector-broker-token": started.internalToken },
        body: JSON.stringify({ op: "ping", timeoutMs: 10 }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toHaveProperty(
      "error",
      expect.stringMatching(/timed out/i),
    );
    const requestReceived = new Promise<void>((resolve) =>
      ws.once("message", () => resolve()),
    );
    const pending = fetch(
      `${started.internalUrl}/internal/connectors/sb-broker/request`,
      {
        method: "POST",
        headers: { "x-connector-broker-token": started.internalToken },
        body: JSON.stringify({ op: "ping" }),
      },
    );
    await requestReceived;
    broker.disconnectConnector("sb-broker");
    expect((await pending).status).toBe(409);
    await expect(
      broker.captureConnectorScreen("sb-broker", "main"),
    ).rejects.toThrow("not connected");
  });

  it("builds public URLs without retaining caller paths, queries or fragments", () => {
    process.env.CONNECTOR_WS_PUBLIC_URL =
      "wss://relay.test/ignored?secret=1#fragment";
    expect(broker.connectorPublicWsUrl("https://unused.test")).toBe(
      "wss://relay.test/connect",
    );
    expect(
      broker.connectorScreenViewerUrl(
        "https://unused.test",
        "ticket/with space",
      ),
    ).toBe("wss://relay.test/screen/view/ticket%2Fwith%20space");
    delete process.env.CONNECTOR_WS_PUBLIC_URL;
    expect(
      broker.connectorPublicWsUrl("https://app.test/old?secret=1#fragment"),
    ).toMatch(/^wss:\/\/app\.test:\d+\/connect$/);
  });
  it("relays binary RFB in both directions, drains preconnection buffers, and consumes viewer tickets once", async () => {
    const connector = await readyConnector();
    let sourceUrl = "";
    connector.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request") {
        sourceUrl = message.args.sourceUrl;
        connector.send(
          JSON.stringify({ type: "response", id: message.id, result: {} }),
        );
      }
    });
    const session = await broker.createConnectorScreenSession(
      "sb-broker",
      "desktop",
      wsUrl,
    );
    const source = await openSocket(sourceUrl, {
      headers: { authorization: "Bearer mcpcon_broker_test" },
    });
    source.send(Buffer.from("RFB 003.008\n"));
    const viewer = new WebSocket(session.viewerUrl);
    const received = new Promise<string>((resolve) =>
      viewer.once("message", (data) => resolve(data.toString())),
    );
    await new Promise<void>((resolve, reject) => {
      viewer.once("open", resolve);
      viewer.once("error", reject);
    });
    expect(await received).toBe("RFB 003.008\n");
    const toSource = new Promise<string>((resolve) =>
      source.once("message", (data) => resolve(data.toString())),
    );
    viewer.send(Buffer.from("viewer handshake"));
    expect(await toSource).toBe("viewer handshake");
    const toViewer = new Promise<string>((resolve) =>
      viewer.once("message", (data) => resolve(data.toString())),
    );
    source.send(Buffer.from("framebuffer"));
    expect(await toViewer).toBe("framebuffer");
    await expect(openSocket(session.viewerUrl)).rejects.toThrow("401");
    await expect(
      openSocket(sourceUrl, {
        headers: { authorization: "Bearer mcpcon_broker_test" },
      }),
    ).rejects.toThrow("409");
    const closed = new Promise<string>((resolve) =>
      viewer.once("close", (_, reason) => resolve(reason.toString())),
    );
    source.close();
    expect(await closed).toBe("screen source disconnected");
    connector.close();
  });

  it("buffers viewer input until the authenticated source arrives and rejects wrong source credentials", async () => {
    const connector = await readyConnector();
    let sourceUrl = "";
    connector.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request") {
        sourceUrl = message.args.sourceUrl;
        connector.send(
          JSON.stringify({ type: "response", id: message.id, result: {} }),
        );
      }
    });
    const session = await broker.createConnectorScreenSession(
      "sb-broker",
      "desktop",
      wsUrl,
    );
    const viewer = await openSocket(session.viewerUrl);
    viewer.send(Buffer.from("early input"));
    await expect(openSocket(sourceUrl)).rejects.toThrow("401");
    const source = new WebSocket(sourceUrl, {
      headers: { authorization: "Bearer mcpcon_broker_test" },
    });
    const received = new Promise<string>((resolve) =>
      source.once("message", (data) => resolve(data.toString())),
    );
    await new Promise<void>((resolve, reject) => {
      source.once("open", resolve);
      source.once("error", reject);
    });
    expect(await received).toBe("early input");
    const closed = new Promise<string>((resolve) =>
      source.once("close", (_, reason) => resolve(reason.toString())),
    );
    viewer.send("not binary");
    expect(await closed).toBe("screen relay requires binary messages");
    connector.close();
  });

  it("replaces screen sessions and rejects opens declined by the connector", async () => {
    const connector = await readyConnector();
    let rejectOpen = false;
    connector.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request")
        connector.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: !rejectOpen,
            error: "screen permission refused",
            result: {},
          }),
        );
    });
    const first = await broker.createConnectorScreenSession(
      "sb-broker",
      "desktop",
      wsUrl,
    );
    const viewer = await openSocket(first.viewerUrl);
    const closed = new Promise<string>((resolve) =>
      viewer.once("close", (_, reason) => resolve(reason.toString())),
    );
    const second = await broker.createConnectorScreenSession(
      "sb-broker",
      "desktop",
      wsUrl,
    );
    expect(await closed).toBe("replaced by a newer screen viewer");
    await expect(openSocket(first.viewerUrl)).rejects.toThrow("401");
    rejectOpen = true;
    await expect(
      broker.createConnectorScreenSession("sb-broker", "desktop", wsUrl),
    ).rejects.toThrow("screen permission refused");
    await expect(openSocket(second.viewerUrl)).rejects.toThrow("401");
    connector.close();
  });

  it("bounds buffered relay messages before the second peer connects", async () => {
    const connector = await readyConnector();
    connector.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request")
        connector.send(
          JSON.stringify({ type: "response", id: message.id, result: {} }),
        );
    });
    const session = await broker.createConnectorScreenSession(
      "sb-broker",
      "desktop",
      wsUrl,
    );
    const viewer = await openSocket(session.viewerUrl);
    const closed = new Promise<string>((resolve) =>
      viewer.once("close", (_, reason) => resolve(reason.toString())),
    );
    for (let index = 0; index < 300; index++)
      viewer.send(Buffer.from([index % 256]));
    expect(await closed).toBe("screen relay buffer exceeded");
    connector.close();
  });

  it("creates terminals, forwards input and resize, replays bounded output, and closes streams on deletion", async () => {
    const connector = await readyConnector();
    const operations: Array<{ op: string; args: unknown }> = [];
    connector.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      operations.push({ op: message.op, args: message.args });
      connector.send(
        JSON.stringify({
          type: "response",
          id: message.id,
          result:
            message.op === "terminal_create"
              ? { terminalId: "terminal-1" }
              : {},
        }),
      );
    });
    const started = await broker.ensureConnectorBroker();
    const url = `${started.internalUrl}/internal/connectors/sb-broker/terminal/session`;
    const headers = { "x-connector-broker-token": started.internalToken };
    const created = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "terminal-1" });
    for (let index = 0; index < 205; index++)
      connector.send(
        JSON.stringify({
          type: "terminal_data",
          terminalId: "terminal-1",
          data: `line-${index}`,
        }),
      );
    connector.send(
      JSON.stringify({ type: "terminal_data", terminalId: "terminal-1" }),
    );
    for (const action of ["input", "resize"])
      expect(
        (
          await fetch(`${url}/terminal-1/${action}`, {
            method: "POST",
            headers,
            body: JSON.stringify({ data: "input", cols: 100 }),
          })
        ).status,
      ).toBe(200);
    expect(operations).toContainEqual({
      op: "terminal_input",
      args: { terminalId: "terminal-1", data: "input", cols: 100 },
    });
    expect(operations).toContainEqual({
      op: "terminal_resize",
      args: { terminalId: "terminal-1", data: "input", cols: 100 },
    });
    const streaming = await fetch(`${url}/terminal-1/stream`, { headers });
    expect(streaming.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    if (!streaming.body) throw new Error("Missing terminal stream");
    const reader = streaming.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: ready");
    expect(first).toContain("line-204");
    expect(first).not.toContain('"line-0"');
    connector.send(
      JSON.stringify({
        type: "terminal_exit",
        terminalId: "terminal-1",
        exitCode: 3,
        signal: "SIGTERM",
      }),
    );
    const exited = new TextDecoder().decode((await reader.read()).value);
    expect(exited).toContain('"exitCode":3');
    expect(exited).toContain('"signal":"SIGTERM"');
    expect(
      (await fetch(`${url}/terminal-1`, { method: "DELETE", headers })).status,
    ).toBe(200);
    expect((await reader.read()).done).toBe(true);
    expect(
      (
        await fetch(`${url}/terminal-1/unknown`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(405);
    expect((await fetch(url, { method: "PATCH", headers })).status).toBe(404);
    connector.close();
  });

  it("reports malformed terminal creation responses and makes disconnected close idempotent", async () => {
    const connector = await readyConnector();
    connector.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request")
        connector.send(
          JSON.stringify({ type: "response", id: message.id, result: {} }),
        );
    });
    const started = await broker.ensureConnectorBroker();
    const url = `${started.internalUrl}/internal/connectors/sb-broker/terminal/session`;
    const headers = { "x-connector-broker-token": started.internalToken };
    const response = await fetch(url, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Connector did not return a terminal id.",
    });
    broker.disconnectConnector("sb-broker");
    expect(
      (await fetch(`${url}/unknown`, { method: "DELETE", headers })).status,
    ).toBe(200);
    await expect(
      openSocket(wsUrl.replace("/connect", "/unknown")),
    ).rejects.toThrow("404");
    await expect(
      openSocket(
        wsUrl.replace(
          "/connect",
          "/screen/source/00000000-0000-0000-0000-000000000000",
        ),
      ),
    ).rejects.toThrow("401");
  });
});
