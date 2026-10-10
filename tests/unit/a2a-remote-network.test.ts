// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publicRemoteAddress,
  remotePair,
  remoteUrl,
  fetchRemoteJson,
  remoteRpcFetch,
  RemoteA2AError,
  REMOTE_RESPONSE_BYTES,
} from "@/lib/a2a/remote-network";
import { REMOTE_CARD, REMOTE_RPC, remoteTask } from "../fixtures/a2a-remote";
import type { A2ALogBinding } from "@/lib/observability/a2a-log";
import { withLogContext } from "@/lib/observability/context";
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  create: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ logEvent: { create: mocks.create } }),
  },
}));
vi.mock("@/lib/observability/settings", () => ({
  getLogSettings: mocks.settings,
}));
const binding: A2ALogBinding = {
  grant: {
    kind: "remote",
    workspaceId: "ws",
    actorId: "actor",
    sourceAgentId: "source",
    remoteAgentId: "remote",
    targetBinding: "approved",
    ownerKey: "private-owner",
    expiresAt: Date.now() + 60_000,
    scopes: ["a2a:send", "a2a:read", "a2a:cancel"],
    maxConcurrent: 1,
    timeoutSeconds: 60,
    retentionDays: 1,
    ancestorTaskIds: ["root"],
    ancestorAgentIds: ["source"],
    parentTaskId: "parent",
    rootTaskId: "root",
  },
  taskId: "local-task",
  contextId: "local-context",
  rootTaskId: "root",
  parentTaskId: "parent",
};
const rpcRequest = (method = "GetTask") => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: { id: "peer-task" },
});
const call = (method = "GetTask", signal?: AbortSignal) =>
  remoteRpcFetch(
    REMOTE_RPC,
    "stored-key",
    binding,
  )(REMOTE_RPC, {
    method: "POST",
    body: JSON.stringify(rpcRequest(method)),
    signal,
  });
let status: number, headers: Record<string, string>, body: string;
let options: Record<string, unknown>;
beforeEach(() => {
  vi.stubEnv(
    "TOOLPLANE_A2A_REMOTE_ORIGINS",
    JSON.stringify(["https://agent.example"]),
  );
  vi.clearAllMocks();
  status = 200;
  headers = { "content-type": "application/json" };
  body = "{}";
  mocks.settings.mockResolvedValue({
    eventDays: 30,
    detailDays: 7,
    auditDays: 180,
    captures: [],
  });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.request.mockImplementation((_url, opts, receive) => {
    options = opts;
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(() => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: status,
          headers,
          complete: true,
          destroy: vi.fn(),
        });
        receive(res);
        queueMicrotask(() => {
          res.emit("data", Buffer.from(body));
          res.emit("end");
        });
      }),
    });
    return req;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("remote HTTPS egress boundary", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.2",
    "172.16.1.1",
    "192.168.1.2",
    "169.254.169.254",
    "100.64.1.1",
    "0.0.0.0",
    "224.1.1.1",
    "198.18.0.1",
    "192.0.2.1",
    "::1",
    "::ffff:93.184.216.34",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
  ])("blocks non-public %s", (address) =>
    expect(publicRemoteAddress(address)).toBe(false),
  );
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])(
    "accepts globally routable %s",
    (address) => expect(publicRemoteAddress(address)).toBe(true),
  );
  it("is default deny and requires exact origin approval", () => {
    vi.stubEnv("TOOLPLANE_A2A_REMOTE_ORIGINS", "[]");
    expect(() => remoteUrl(REMOTE_RPC)).toThrow();
    vi.stubEnv(
      "TOOLPLANE_A2A_REMOTE_ORIGINS",
      '["https://agent.example/path"]',
    );
    expect(() => remoteUrl(REMOTE_RPC)).toThrow();
  });
  it.each([
    "http://agent.example/a2a",
    "https://user:pass@agent.example/a2a",
    "https://agent.example/a2a?x=1",
    "https://agent.example/a2a#x",
    "https://other.example/a2a",
    "https://agent.example:444/a2a",
    " https://agent.example/a2a",
    "https://agent.example\\bad",
  ])("rejects unapproved address %s", (url) =>
    expect(() => remoteUrl(url)).toThrow(),
  );
  it("binds Card and RPC to distinct paths on the same origin", () => {
    expect(remotePair(REMOTE_CARD, REMOTE_RPC)).toEqual({
      cardUrl: REMOTE_CARD,
      rpcUrl: REMOTE_RPC,
    });
    expect(() => remotePair(REMOTE_RPC, REMOTE_RPC)).toThrow();
  });
  it("rejects mixed public/private DNS before making any connection", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      fetchRemoteJson(REMOTE_CARD, "GET", undefined, "secret"),
    ).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("pins the actual lookup and leaves TLS/hostname verification enabled", async () => {
    await fetchRemoteJson(REMOTE_CARD, "GET", undefined, "secret");
    const callback = vi.fn();
    (
      options.lookup as (
        host: string,
        opts: { all: boolean },
        cb: typeof callback,
      ) => void
    )("agent.example", { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.checkServerIdentity).toBeUndefined();
    expect(options.headers).toMatchObject({
      authorization: "Bearer secret",
      "accept-encoding": "identity",
    });
  });
  it.each([204, 205, 301, 302, 307, 401, 500])(
    "does not follow redirects or retry HTTP %s",
    async (code) => {
      status = code;
      headers.location = "http://169.254.169.254";
      await expect(
        fetchRemoteJson(REMOTE_CARD, "GET", undefined, "secret"),
      ).rejects.toThrow();
      expect(mocks.request).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects compressed, non-JSON and oversized bodies", async () => {
    headers["content-encoding"] = "gzip";
    await expect(
      fetchRemoteJson(REMOTE_CARD, "GET", undefined, undefined),
    ).rejects.toThrow();
    headers = { "content-type": "text/html" };
    await expect(
      fetchRemoteJson(REMOTE_CARD, "GET", undefined, undefined),
    ).rejects.toThrow();
    headers = { "content-type": "application/json" };
    body = "x".repeat(REMOTE_RESPONSE_BYTES + 1);
    await expect(
      fetchRemoteJson(REMOTE_CARD, "GET", undefined, undefined),
    ).rejects.toThrow();
  });
  it("honors an already-aborted signal even before DNS completes", async () => {
    mocks.lookup.mockReturnValue(new Promise(() => undefined));
    await expect(
      fetchRemoteJson(
        REMOTE_CARD,
        "GET",
        undefined,
        undefined,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("uses only the stored credential, validates wire output and refuses SDK target changes", async () => {
    body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: remoteTask() });
    const fetcher = remoteRpcFetch(REMOTE_RPC, "stored-key", binding);
    await fetcher(REMOTE_RPC, {
      method: "POST",
      headers: { authorization: "Bearer injected", cookie: "private" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "GetTask",
        params: { id: "peer-task" },
      }),
    });
    expect(options.headers).toMatchObject({
      authorization: "Bearer stored-key",
    });
    expect(options.headers).not.toHaveProperty("cookie");
    await expect(fetcher(REMOTE_CARD, { method: "POST" })).rejects.toThrow();
    body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        ...remoteTask(),
        artifacts: [
          { artifactId: "x", parts: [{ text: "x", url: "https://private" }] },
        ],
      },
    });
    await expect(
      fetcher(REMOTE_RPC, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask" }),
      }),
    ).rejects.toThrow();
  });
  it.each(["SendMessage", "GetTask", "CancelTask"])(
    "records the actual %s response once using local task identity",
    async (method) => {
      const task = remoteTask(
        method === "CancelTask" ? "TASK_STATE_CANCELED" : "TASK_STATE_WORKING",
        "safe reply stored-key",
      );
      const envelope = {
        jsonrpc: "2.0",
        id: 1,
        result: method === "SendMessage" ? { task } : task,
      };
      body = JSON.stringify(envelope);
      const response = await withLogContext(
        { traceId: "trace", requestId: "request", suppressPayload: true },
        () => call(method),
      );
      expect(await response.json()).toEqual(envelope);
      expect(mocks.create).toHaveBeenCalledOnce();
      const logged = mocks.create.mock.calls[0][0].data;
      expect(logged).toMatchObject({
        domain: "a2a",
        eventName: "a2a.request",
        rpcMethod: method,
        httpStatus: 200,
        outcome: method === "CancelTask" ? "cancelled" : "success",
        workspaceId: "ws",
        actorId: "actor",
        agentId: "source",
        traceId: "trace",
        requestId: "request",
      });
      expect(logged.attributes.data.a2a).toEqual({
        direction: "outbound",
        transport: "jsonrpc",
        remoteAgentId: "remote",
        taskId: "local-task",
        contextId: "local-context",
        rootTaskId: "root",
        parentTaskId: "parent",
        taskState:
          method === "CancelTask"
            ? "TASK_STATE_CANCELED"
            : "TASK_STATE_WORKING",
      });
      expect(logged.detail.create.data.payload).toMatchObject({
        request: rpcRequest(method),
        response: {
          result:
            method === "SendMessage"
              ? { task: { id: task.id } }
              : { id: task.id },
        },
        responseKind: "json",
        responseComplete: true,
      });
      expect(JSON.stringify(logged.detail)).toContain("safe reply");
      expect(JSON.stringify(logged)).not.toContain("stored-key");
      expect(JSON.stringify(logged.attributes)).not.toContain("peer-task");
      expect(
        JSON.stringify(vi.mocked(process.stderr.write).mock.calls),
      ).not.toContain("safe reply");
    },
  );
  it.each(["TASK_STATE_FAILED", "TASK_STATE_REJECTED"])(
    "records %s as a business failure despite HTTP success",
    async (state) => {
      body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: remoteTask(state),
      });
      await call();
      expect(mocks.create.mock.calls[0][0].data).toMatchObject({
        outcome: "error",
        httpStatus: 200,
        attributes: { data: { a2a: { taskState: state } } },
      });
    },
  );
  it("retains a numeric RPC business error without exposing its text in metadata", async () => {
    body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "private task missing stored-key" },
    });
    await call();
    const logged = mocks.create.mock.calls[0][0].data;
    expect(logged).toMatchObject({
      outcome: "error",
      httpStatus: 200,
      attributes: { data: { a2a: { rpcErrorCode: -32001 } } },
    });
    expect(logged.detail.create.data.payload.response.error).toEqual({
      code: -32001,
      message: "private task missing [REDACTED]",
    });
    expect(JSON.stringify(logged.attributes)).not.toContain(
      "private task missing",
    );
  });
  it("preserves the observed HTTP status and response when wire validation rejects it", async () => {
    const envelope = { jsonrpc: "2.0", id: 999, result: remoteTask() };
    body = JSON.stringify(envelope);
    await expect(call()).rejects.toMatchObject({
      httpStatus: 200,
      message: "Remote output is not a valid supported A2A response.",
    });
    const logged = mocks.create.mock.calls[0][0].data;
    expect(logged).toMatchObject({ outcome: "error", httpStatus: 200 });
    expect(logged.detail.create.data.payload).toEqual({
      request: rpcRequest(),
      response: envelope,
      responseKind: "json",
      responseComplete: true,
    });
  });
  it.each([401, 403, 500])(
    "retains HTTP %s and never captures its rejected response body",
    async (code) => {
      status = code;
      body = "unsafe rejected body";
      await expect(call()).rejects.toMatchObject({
        httpStatus: code,
        message: new RemoteA2AError().message,
      });
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(mocks.create).toHaveBeenCalledOnce();
      const logged = mocks.create.mock.calls[0][0].data;
      expect(logged).toMatchObject({
        httpStatus: code,
        outcome: code === 500 ? "error" : "denied",
      });
      if (code === 500)
        expect(logged.detail.create.data.payload).toEqual({
          request: rpcRequest(),
          responseKind: "none",
          responseComplete: false,
        });
      else expect(logged.detail).toBeUndefined();
      expect(JSON.stringify(logged)).not.toContain("unsafe rejected body");
    },
  );
  it.each([
    { "content-encoding": "gzip" },
    { "content-type": "text/html" },
    { "content-length": String(REMOTE_RESPONSE_BYTES + 1) },
  ])("does not read rejected response formats %j", async (rejectedHeaders) => {
    Object.assign(headers, rejectedHeaders);
    body = "unsafe rejected body";
    await expect(call()).rejects.toMatchObject({ httpStatus: 200 });
    const logged = mocks.create.mock.calls[0][0].data;
    expect(logged).toMatchObject({ outcome: "error", httpStatus: 200 });
    expect(logged.detail.create.data.payload).toEqual({
      request: rpcRequest(),
      responseKind: "none",
      responseComplete: false,
    });
  });
  it("does not fabricate a response or HTTP status after a DNS failure", async () => {
    mocks.lookup.mockRejectedValue(new Error("DNS unavailable"));
    await expect(call()).rejects.toThrow("DNS unavailable");
    const logged = mocks.create.mock.calls[0][0].data;
    expect(logged.outcome).toBe("error");
    expect(logged.httpStatus ?? null).toBeNull();
    expect(logged.detail.create.data.payload).toEqual({
      request: rpcRequest(),
      responseKind: "none",
      responseComplete: false,
    });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it.each([
    {
      reason: new DOMException("Deadline exceeded", "TimeoutError"),
      outcome: "timeout",
    },
    { reason: new DOMException("Stopped", "AbortError"), outcome: "cancelled" },
  ])(
    "classifies actual abort reasons as $outcome",
    async ({ reason, outcome }) => {
      mocks.lookup.mockReturnValue(Promise.withResolvers().promise);
      await expect(
        call("GetTask", AbortSignal.abort(reason)),
      ).rejects.toThrow();
      const logged = mocks.create.mock.calls[0][0].data;
      expect(logged.outcome).toBe(outcome);
      expect(logged.httpStatus ?? null).toBeNull();
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
  it("leaves the actual RPC result available when log persistence fails", async () => {
    mocks.create.mockRejectedValueOnce(new Error("database unavailable"));
    const envelope = { jsonrpc: "2.0", id: 1, result: remoteTask() };
    body = JSON.stringify(envelope);
    expect(await (await call()).json()).toEqual(envelope);
  });
});
