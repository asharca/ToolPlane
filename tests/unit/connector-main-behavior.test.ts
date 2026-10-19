// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ socket: vi.fn() }));
vi.mock("ws", () => ({
  default: class {
    static OPEN = 1;
    constructor(...args: unknown[]) {
      // biome-ignore lint/correctness/noConstructorReturn: Substitutes an event-driven transport at the external WebSocket boundary.
      return mocks.socket(...args);
    }
  },
}));
import {
  main,
  PROTOCOL_VERSION,
} from "../../packages/connector/bin/runtime.mjs";
class Client extends EventEmitter {
  readyState = 1;
  send = vi.fn();
}
let root: string;
let client: Client;
const fetchMock = vi.fn();
const originalArgv = process.argv;
let originalSignalHandlers: Record<
  string,
  Array<(...args: never[]) => unknown>
>;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "connector-main-"));
  originalSignalHandlers = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  };
  process.argv = [
    process.execPath,
    "connector",
    "connect",
    "--server",
    "https://broker.example",
    "--token",
    "secret",
    "--root",
    root,
  ];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () =>
    Response.json({
      wsUrl: "wss://broker.example/ws",
      protocolVersion: PROTOCOL_VERSION,
      sandboxId: "sandbox",
    }),
  );
  client = new Client();
  mocks.socket.mockReturnValue(client);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  process.argv = originalArgv;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal))
      if (!originalSignalHandlers[signal].includes(listener))
        process.removeListener(signal, listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("connector CLI bootstrap and request lifecycle", () => {
  it.each([
    { status: 401, body: { error: "unauthorized" }, expected: "unauthorized" },
    { status: 500, body: {}, expected: "bootstrap failed (500)" },
    { status: 200, body: {}, expected: "did not return a wsUrl" },
    {
      status: 200,
      body: { wsUrl: "wss://broker.example/ws", protocolVersion: "old" },
      expected: "protocol mismatch",
    },
  ])(
    "rejects unusable bootstrap metadata %j",
    async ({ status, body, expected }) => {
      fetchMock.mockImplementation(async () => Response.json(body, { status }));
      await expect(main()).rejects.toThrow(expected);
      expect(mocks.socket).not.toHaveBeenCalled();
    },
  );
  it("reports malformed bootstrap JSON as an HTTP failure", async () => {
    fetchMock.mockImplementation(
      async () => new Response("not-json", { status: 503 }),
    );
    await expect(main()).rejects.toThrow("bootstrap failed (503)");
  });
  it.each([
    "Unexpected server response: 401",
    "Unexpected server response: 403",
  ])(
    "does not reconnect on broker authorization denial: %s",
    async (message) => {
      const pending = main();
      await vi.waitFor(() => expect(mocks.socket).toHaveBeenCalledOnce());
      client.emit("error", new Error(message));
      await pending;
      expect(console.error).toHaveBeenCalledWith(`[connector] ${message}`);
    },
  );
  it("sends hello and request responses, ignores malformed messages, then stops on server revocation", async () => {
    const pending = main();
    await vi.waitFor(() => expect(mocks.socket).toHaveBeenCalledOnce());
    client.emit("open");
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledOnce());
    expect(JSON.parse(client.send.mock.calls[0][0])).toMatchObject({
      type: "hello",
      root,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(fetchMock.mock.calls[0]).toEqual([
      new URL("https://broker.example/api/v1/connectors/bootstrap"),
      {
        headers: { accept: "application/json", authorization: "Bearer secret" },
      },
    ]);
    client.emit("message", Buffer.from("not-json"));
    client.emit("message", Buffer.from(JSON.stringify({ type: "notice" })));
    client.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "request", id: "denied", op: "unsupported" }),
      ),
    );
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(client.send.mock.calls[1][0])).toEqual({
      type: "response",
      id: "denied",
      ok: false,
      error: "Unknown connector op: unsupported",
    });
    client.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "request", id: "ping", op: "ping" })),
    );
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledTimes(3));
    expect(JSON.parse(client.send.mock.calls[2][0])).toMatchObject({
      type: "response",
      id: "ping",
      ok: true,
      result: { ok: true },
    });
    client.readyState = 3;
    client.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "request",
          id: "closed-error",
          op: "unsupported",
        }),
      ),
    );
    client.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "request",
          id: "closed-success",
          op: "terminal_close",
        }),
      ),
    );
    client.emit("close", 4001, Buffer.from("revoked"));
    await pending;
    expect(client.send).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(
      "[connector] session closed by server (4001): revoked",
    );
  });
});
