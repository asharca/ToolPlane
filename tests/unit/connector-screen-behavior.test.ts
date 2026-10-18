// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), webSocket: vi.fn() }));
vi.mock("node:net", () => ({ default: { createConnection: mocks.connect } }));
vi.mock("ws", () => ({
  default: class {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(...args: unknown[]) {
      // biome-ignore lint/correctness/noConstructorReturn: The constructor substitutes a controlled transport at this external I/O boundary.
      return mocks.webSocket(...args);
    }
  },
}));
import {
  createRuntime,
  probeVncEndpoint,
} from "../../packages/connector/bin/runtime.mjs";
class Source extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sendError: Error | undefined;
  send = vi.fn((_data, _options, callback) => callback?.(this.sendError));
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
  });
}
class Socket extends EventEmitter {
  writableLength = 0;
  destroy = vi.fn();
  write = vi.fn();
  setTimeout = vi.fn();
}
let source: Source;
let socket: Socket;
const options = {
  screenVnc: "auto",
  wsUrl: "wss://broker.example/connectors/ws",
  token: "private-token",
};
const args = {
  displayId: "vnc",
  sessionId: "session",
  sourceUrl: "wss://broker.example/screen/source",
};
beforeEach(() => {
  vi.resetAllMocks();
  source = new Source();
  socket = new Socket();
  mocks.webSocket.mockImplementation(() => source);
  mocks.connect.mockReturnValue(socket);
});
afterEach(() => vi.useRealTimers());
async function open(
  runtime: {
    handle: (
      ws: unknown,
      op: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
  },
  session = args,
) {
  const pending = runtime.handle(null, "screen_open", session);
  source.readyState = 1;
  source.emit("open");
  socket.emit("connect");
  await expect(pending).resolves.toEqual({
    ok: true,
    sessionId: session.sessionId,
    displayId: "vnc",
  });
}

describe("connector screen relay origin and connection security", () => {
  it("does not expose screen capability or operations without configuration", async () => {
    const runtime = createRuntime("/tmp/connector-screen");
    expect(runtime.info.capabilities).not.toContain("screen");
    await expect(runtime.handle(null, "screen_open", args)).rejects.toThrow(
      "VNC screen is not configured",
    );
  });
  it.each([
    {},
    { screenVnc: "auto" },
    { screenVnc: "auto", wsUrl: options.wsUrl },
  ])("requires authenticated broker configuration", async (configuration) => {
    const runtime = createRuntime("/tmp/connector-screen", configuration);
    await expect(runtime.handle(null, "screen_open", args)).rejects.toThrow(
      configuration.screenVnc
        ? "Screen relay is not configured"
        : "VNC screen is not configured",
    );
    expect(mocks.webSocket).not.toHaveBeenCalled();
  });
  it.each([
    "http://broker.example/screen",
    "ws://broker.example/screen",
    "wss://evil.example/screen",
    "wss://user@broker.example/screen",
    "wss://user:password@broker.example/screen",
    "wss://broker.example/screen#fragment",
    "not a URL",
  ])("rejects unsafe relay URL %s", async (sourceUrl) => {
    const runtime = createRuntime("/tmp/connector-screen", options);
    await expect(
      runtime.handle(null, "screen_open", { ...args, sourceUrl }),
    ).rejects.toThrow();
    expect(mocks.webSocket).not.toHaveBeenCalled();
  });
  it("rejects malformed configured broker URLs", async () => {
    const runtime = createRuntime("/tmp/connector-screen", {
      ...options,
      wsUrl: "not-url",
    });
    await expect(runtime.handle(null, "screen_open", args)).rejects.toThrow(
      "Invalid screen source URL",
    );
  });
  it.each(["", "a/b", "x".repeat(129)])(
    "rejects unbounded session ids %j",
    async (sessionId) => {
      const runtime = createRuntime("/tmp/connector-screen", options);
      await expect(
        runtime.handle(null, "screen_open", { ...args, sessionId }),
      ).rejects.toThrow("Invalid screen session id");
    },
  );
  it("rejects unknown displays without connecting", async () => {
    const runtime = createRuntime("/tmp/connector-screen", options);
    await expect(
      runtime.handle(null, "screen_open", { ...args, displayId: "main" }),
    ).rejects.toThrow("Unknown display");
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([
    "source-error",
    "socket-error",
    "source-close",
    "socket-close",
    "rejected",
    "non-error",
  ])("cleans both transports when connection fails: %s", async (failure) => {
    const runtime = createRuntime("/tmp/connector-screen", options);
    const pending = runtime.handle(null, "screen_open", args);
    const assertion = expect(pending).rejects.toThrow(
      failure === "rejected"
        ? "rejected the connector (401)"
        : failure === "source-close"
          ? "Screen relay closed during connection"
          : failure === "socket-close"
            ? "VNC server closed during connection"
            : failure === "non-error"
              ? "Screen relay connection failed"
              : "connection refused",
    );
    if (failure === "source-error")
      source.emit("error", new Error("connection refused"));
    if (failure === "socket-error")
      socket.emit("error", new Error("connection refused"));
    if (failure === "source-close") source.emit("close");
    if (failure === "socket-close") socket.emit("close");
    if (failure === "rejected")
      source.emit("unexpected-response", {}, { statusCode: 401 });
    if (failure === "non-error") source.emit("error", "error");
    await assertion;
    expect(source.close).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it("bounds connection time and ignores a second failure after settling", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime("/tmp/connector-screen", options);
    const pending = runtime.handle(null, "screen_open", args);
    const assertion = expect(pending).rejects.toThrow("connection timed out");
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    source.emit("error", new Error("late failure"));
    socket.emit("close");
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});

describe("connector binary RFB relay", () => {
  it("waits for both peers and sends bearer credentials only through headers", async () => {
    const runtime = createRuntime("/tmp/connector-screen", {
      ...options,
      screenVnc: { host: "127.0.0.1", port: 5901 },
    });
    const pending = runtime.handle(null, "screen_open", args);
    socket.emit("connect");
    source.readyState = 1;
    source.emit("open");
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mocks.webSocket).toHaveBeenCalledWith(args.sourceUrl, {
      headers: { authorization: "Bearer private-token" },
      maxPayload: 8000000,
      perMessageDeflate: false,
    });
    await expect(runtime.handle(null, "screen_open", args)).rejects.toThrow(
      "already exists",
    );
    runtime.closeAllTerminals();
    runtime.closeAllTerminals();
    expect(source.close).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
  it("relays fragmented normal banners and binary frames without rewriting their data", async () => {
    const runtime = createRuntime("/tmp/connector-screen", options);
    await open(runtime);
    socket.emit("data", Buffer.from("RFB 003."));
    expect(source.send).not.toHaveBeenCalled();
    socket.emit("data", Buffer.from("008\nhello"));
    expect(source.send.mock.calls.map((call) => call[0])).toEqual([
      Buffer.from("RFB 003.008\n"),
      Buffer.from("hello"),
    ]);
    source.emit("message", [Buffer.from([1]), Buffer.from([2])], true);
    expect(socket.write).toHaveBeenCalledWith(Buffer.from([1, 2]));
    source.emit("message", Buffer.from([3]), true);
    expect(socket.write).toHaveBeenLastCalledWith(Buffer.from([3]));
    runtime.closeAllTerminals();
  });
  it.each([
    { security: [2, 1, 2] },
    { security: [2, 1, 30] },
    { security: [0] },
  ])(
    "normalizes Apple banners and restricts offered authentication when supported: %j",
    async ({ security }) => {
      const runtime = createRuntime("/tmp/connector-screen", options);
      await open(runtime);
      socket.emit("data", Buffer.from("RFB 003.889\n"));
      expect(source.send.mock.calls[0][0]).toEqual(
        Buffer.from("RFB 003.008\n"),
      );
      socket.emit("data", Buffer.from([security[0]]));
      if (security[0] > 0) {
        expect(source.send).toHaveBeenCalledOnce();
        socket.emit("data", Buffer.from(security.slice(1)));
      }
      expect(source.send.mock.calls[1][0]).toEqual(
        Buffer.from(
          security.includes(2) && security.length > 1 && security[2] === 2
            ? [1, 2]
            : security,
        ),
      );
      runtime.closeAllTerminals();
    },
  );
  it("closes viewer text frames with the binary-only protocol code", async () => {
    const runtime = createRuntime("/tmp/connector-screen", options);
    await open(runtime);
    source.emit("message", "not binary", false);
    expect(source.close).toHaveBeenCalledWith(1003, "binary RFB data required");
    expect(socket.write).not.toHaveBeenCalled();
    runtime.closeAllTerminals();
  });
  it.each([
    "viewer",
    "vnc",
    "send-error",
    "source-error",
    "socket-error",
    "source-close",
    "socket-close",
  ])(
    "releases overloaded or disconnected relay sessions: %s",
    async (failure) => {
      const runtime = createRuntime("/tmp/connector-screen", options);
      await open(runtime);
      if (failure === "viewer") {
        source.bufferedAmount = 8000000;
        socket.emit("data", Buffer.from("RFB 003.008\n"));
      }
      if (failure === "vnc") {
        socket.writableLength = 8000000;
        source.emit("message", Buffer.from([1]), true);
      }
      if (failure === "send-error") {
        source.sendError = new Error("send failed");
        socket.emit("data", Buffer.from("RFB 003.008\n"));
      }
      if (failure === "source-error") source.emit("error", new Error("broken"));
      if (failure === "socket-error") socket.emit("error", new Error("broken"));
      if (failure === "source-close") source.emit("close");
      if (failure === "socket-close") socket.emit("close");
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(source.close).toHaveBeenCalledOnce();
      runtime.closeAllTerminals();
      expect(socket.destroy).toHaveBeenCalledOnce();
    },
  );
  it("does not write back to a closed viewer", async () => {
    const runtime = createRuntime("/tmp/connector-screen", options);
    await open(runtime);
    source.readyState = 3;
    socket.emit("data", Buffer.from("RFB 003.008\n"));
    expect(source.send).not.toHaveBeenCalled();
    runtime.closeAllTerminals();
    expect(source.close).not.toHaveBeenCalled();
  });
  it.each(["connect", "error", "timeout"])(
    "settles local VNC availability probes on %s",
    async (event) => {
      const pending = probeVncEndpoint({ host: "127.0.0.1", port: 5900 }, 9999);
      socket.emit(event);
      socket.emit("timeout");
      await expect(pending).resolves.toBe(event === "connect");
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(socket.setTimeout).toHaveBeenCalledWith(5000);
    },
  );
});
