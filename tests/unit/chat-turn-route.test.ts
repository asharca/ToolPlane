import { assertDefined } from "../assert-defined";
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NativeRunOptions } from "@/lib/agents/native";
import type { UIMessageChunk } from "ai";
import type { ChatRunFence, ChatRunScope } from "@/lib/chat/run-control";
import type * as RuntimeOwnership from "@/lib/runtime/ownership-state";
import {
  assertRuntimeOwner,
  RuntimeUnavailableError,
} from "@/lib/runtime/ownership-state";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  buildKeylessWebSearch: vi.fn(),
  buildTools: vi.fn(),
  complete: vi.fn(),
  finish: vi.fn(),
  getHistory: vi.fn(),
  getThread: vi.fn(),
  replay: vi.fn(),
  hydrate: vi.fn(),
  resolveUser: vi.fn(),
  runNative: vi.fn(),
  start: vi.fn(),
  subscribe: vi.fn(),
  cancel: vi.fn(),
  recover: vi.fn(),
  wrap: vi.fn(),
}));
vi.mock("@/lib/auth/request-user", () => ({
  resolveRequestUser: mocks.resolveUser,
}));
vi.mock("@/lib/workspace/access-stream", () => ({
  workspaceAccessResponse: (response: Response) => response,
}));
vi.mock("@/lib/chat/tools", () => ({ buildChatToolSet: mocks.buildTools }));
vi.mock("@/lib/chat/durable-tools", () => ({ wrapChatTools: mocks.wrap }));
vi.mock("@/lib/runtime/ownership-state", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeOwnership>()),
  assertRuntimeOwner: vi.fn(),
  runtimeRequestUnavailable: vi.fn(() => false),
  runtimeRequest<T>(
    _route: string,
    _method: string,
    operation: () => Promise<T>,
  ) {
    return operation();
  },
}));
vi.mock("@/lib/chat/run-control", () => ({
  startChatRun: mocks.start,
  subscribeChatRun: mocks.subscribe,
  cancelChatRun: mocks.cancel,
  recoverStaleChatRuns: mocks.recover,
  chatRunHeaders: () => ({ "X-Chat-Turn-Id": "turn-1" }),
  getChatRunSnapshot: vi.fn(),
}));
vi.mock("@/lib/chat/keyless-web-search", () => ({
  buildKeylessWebSearchToolSet: mocks.buildKeylessWebSearch,
}));
vi.mock("@/lib/agents/native", () => ({
  runNativeAgent: mocks.runNative,
  uiMessagesToPi: () => [],
}));
vi.mock("@/lib/attachments/messages", () => ({
  AttachmentMessageError: class AttachmentMessageError extends Error {},
  hydrateWorkspaceAttachmentMessages: mocks.hydrate,
}));
vi.mock("@/lib/chat/service", () => ({
  ChatServiceError: class ChatServiceError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  beginChatTurn: mocks.begin,
  completeChatTurn: mocks.complete,
  finishChatTurn: mocks.finish,
  getChatHistoryForExecution: mocks.getHistory,
  getChatThreadForExecution: mocks.getThread,
  getChatThreadForUser: mocks.getThread,
  getChatTurnReplay: mocks.replay,
}));

import { POST, DELETE } from "@/app/api/v1/chat/threads/[threadId]/turns/route";
import { GET } from "@/app/api/v1/chat/threads/[threadId]/turns/stream/route";
import { ChatServiceError } from "@/lib/chat/service";
const params = { params: Promise.resolve({ threadId: "thread-1" }) };
const url = "http://toolplane.test/api/v1/chat/threads/thread-1/turns";
function request(signal?: AbortSignal, webSearchEnabled = false) {
  return new Request(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "request-1",
      messages: [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Retry" }],
        },
      ],
      trigger: "regenerate-message",
      messageId: "assistant-old",
      webSearchEnabled,
      reasoningEffort: "high",
    }),
  });
}
function stop(turnId = "turn-1") {
  return DELETE(
    new Request(url, { method: "DELETE", body: JSON.stringify({ turnId }) }),
    params,
  );
}
async function text(options: NativeRunOptions, delta: string) {
  await options.onEvent?.({
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: {} as AssistantMessage,
  });
}

describe("server-owned assistant turns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUser.mockResolvedValue({ id: "user-1" });
    mocks.replay.mockResolvedValue(null);
    const fence = { leaseToken: "lease-1", generation: 1 };
    const controller = new AbortController();
    const chunks: UIMessageChunk[] = [];
    const subscribers = new Set<
      ReadableStreamDefaultController<UIMessageChunk>
    >();
    let done = false;
    const output = () => ({
      turnId: "turn-1",
      cursor: 0,
      status: "pending",
      stream: new ReadableStream<UIMessageChunk>({
        start(subscriber) {
          for (const chunk of chunks) subscriber.enqueue(chunk);
          if (done) subscriber.close();
          else subscribers.add(subscriber);
        },
        cancel() {
          subscribers.clear();
        },
      }),
    });
    mocks.start.mockImplementation(
      async (
        _scope: ChatRunScope,
        create: (
          signal: AbortSignal,
          fence: ChatRunFence,
        ) => ReadableStream<UIMessageChunk>,
        finalize: (fence: ChatRunFence) => Promise<void>,
      ) => {
        const reader = create(controller.signal, fence).getReader();
        void (async () => {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            chunks.push(result.value);
            for (const subscriber of subscribers)
              subscriber.enqueue(result.value);
          }
          await finalize(fence);
          done = true;
          for (const subscriber of subscribers) subscriber.close();
          subscribers.clear();
        })();
        return output();
      },
    );
    mocks.subscribe.mockImplementation(async (_threadId, activeMessageId) =>
      activeMessageId === "assistant-stable" ? output() : null,
    );
    mocks.cancel.mockImplementation(async (_threadId, turnId) => {
      if (turnId !== "turn-1") return false;
      controller.abort(new DOMException("Stopped", "AbortError"));
      return true;
    });
    mocks.wrap.mockImplementation((tools) => tools);
    mocks.getThread.mockResolvedValue({
      workspaceId: "workspace-1",
      revisionConfig: {
        schemaVersion: 1,
        systemPrompt: null,
        modelProviderId: "provider-1",
        model: "current-model",
        modelParameters: { temperature: 0.4 },
        maxSteps: 5,
        promptTemplates: [],
        mcpGrants: [],
      },
      branch: {
        activeMessageId: "assistant-stable",
        nodes: [{ id: "assistant-old", modelId: "historic-model" }],
      },
      assistant: {
        id: "assistant-1",
        modelProvider: { id: "provider-1" },
        model: "current-model",
        mcpGrants: [],
        systemPrompt: null,
        modelParameters: { temperature: 0.4 },
        maxSteps: 5,
      },
    });
    mocks.begin.mockResolvedValue({
      id: "turn-1",
      assistantMessageId: "assistant-stable",
      historyLeafId: "user-1",
    });
    mocks.buildTools.mockResolvedValue({});
    mocks.buildKeylessWebSearch.mockReturnValue({ web_search: {} });
    mocks.getHistory.mockResolvedValue([]);
    mocks.hydrate.mockResolvedValue([]);
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => {
      await text(options, "Saved answer");
    });
  });

  it("rejects an unavailable runtime before admission and permits the same request to retry", async () => {
    vi.mocked(assertRuntimeOwner).mockImplementationOnce(() => {
      throw new RuntimeUnavailableError();
    });

    const unavailable = await POST(request(), params);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "runtime_not_ready" });
    expect(unavailable.headers.get("Retry-After")).toBe("5");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.buildTools).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.runNative).not.toHaveBeenCalled();

    const retried = await POST(request(), params);
    expect(retried.status).toBe(200);
    expect(await retried.text()).toContain("Saved answer");
    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("finishes and persists after disconnect, replays without invoking the model twice", async () => {
    const gate = Promise.withResolvers<void>();
    let executionSignal: AbortSignal | undefined;
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => {
      executionSignal = options.signal;
      await text(options, "Before ");
      await gate.promise;
      await text(options, "after disconnect");
    });
    const controller = new AbortController();
    const response = await POST(request(controller.signal, true), params);
    const reader = assertDefined(response.body).getReader();
    await reader.read();
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    controller.abort();
    await reader.cancel();
    expect(assertDefined(executionSignal).aborted).toBe(false);
    expect(
      assertDefined(mocks.buildKeylessWebSearch.mock.calls[0])[0].aborted,
    ).toBe(false);
    const resumed = await GET(new Request(`${url}/stream`), params);
    gate.resolve();
    const replay = await resumed.text();
    expect(replay).toContain("Before ");
    expect(replay).toContain("after disconnect");
    expect(mocks.complete).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      "assistant-stable",
      [
        expect.objectContaining({
          type: "text",
          text: "Before after disconnect",
        }),
      ],
      { leaseToken: "lease-1", generation: 1 },
    );
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.runNative).toHaveBeenCalledTimes(1);
    expect(mocks.runNative).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "historic-model",
        reasoningEffort: "high",
      }),
    );
    expect(mocks.begin).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Array),
      { workspaceId: "workspace-1", userId: "user-1" },
      expect.objectContaining({
        idempotencyKey: "request-1",
        requestHash: expect.any(String),
      }),
    );
    expect(mocks.buildTools).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "assistant-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        config: expect.objectContaining({ schemaVersion: 1 }),
      }),
    );
    expect(mocks.wrap).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        fence: { leaseToken: "lease-1", generation: 1 },
        turnId: "turn-1",
      }),
    );
  });

  it("replays a claimed run before checking revoked sources or an unavailable provider", async () => {
    mocks.replay.mockResolvedValueOnce({
      runId: "turn-1",
      workspaceId: "workspace-1",
    });
    mocks.getThread.mockRejectedValue(
      new Error("Pinned source revoked or provider unavailable"),
    );
    mocks.subscribe.mockResolvedValueOnce({
      turnId: "turn-1",
      cursor: 9,
      status: "completed",
      stream: new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: "finish" });
          controller.close();
        },
      }),
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"type":"finish"');
    expect(mocks.replay).toHaveBeenCalledWith(
      "user-1",
      "thread-1",
      "request-1",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(mocks.recover.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replay.mock.invocationCallOrder[0],
    );
    expect(mocks.subscribe).toHaveBeenCalledWith("thread-1", null, {
      userId: "user-1",
      workspaceId: "workspace-1",
      runId: "turn-1",
    });
    expect(mocks.getThread).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.buildTools).not.toHaveBeenCalled();
    expect(mocks.runNative).not.toHaveBeenCalled();
  });

  it("returns no content for unavailable replay output without starting a run", async () => {
    mocks.replay.mockResolvedValueOnce({
      runId: "turn-1",
      workspaceId: "workspace-1",
    });
    mocks.subscribe.mockResolvedValueOnce(null);
    expect((await POST(request(), params)).status).toBe(204);
    expect(mocks.getThread).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([403, 409])(
    "preserves replay actor/hash conflict status %s without new execution",
    async (status) => {
      mocks.replay.mockRejectedValueOnce(
        new ChatServiceError(status, "Idempotency conflict"),
      );
      const response = await POST(request(), params);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "Idempotency conflict" });
      expect(mocks.getThread).not.toHaveBeenCalled();
      expect(mocks.subscribe).not.toHaveBeenCalled();
      expect(mocks.begin).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.runNative).not.toHaveBeenCalled();
    },
  );

  it("reuses a durable admitted turn without restarting the provider", async () => {
    mocks.begin.mockResolvedValueOnce({
      id: "turn-1",
      assistantMessageId: "assistant-stable",
      historyLeafId: "user-1",
      replayed: true,
    });
    mocks.start.mockResolvedValueOnce({
      turnId: "turn-1",
      cursor: 4,
      status: "completed",
      stream: new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.close();
        },
      }),
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.start).toHaveBeenCalledWith(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        assistantMessageId: "assistant-stable",
        workspaceId: "workspace-1",
        userId: "user-1",
      },
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.runNative).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("awaits durable replay with the authenticated scope and event cursor", async () => {
    mocks.subscribe.mockResolvedValueOnce(null);
    const response = await GET(
      new Request(`${url}/stream?runId=turn-1&afterSequence=7`),
      params,
    );
    expect(response.status).toBe(204);
    expect(mocks.subscribe).toHaveBeenCalledWith(
      "thread-1",
      "assistant-stable",
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        runId: "turn-1",
        afterSequence: 7,
      },
    );
  });

  it.each(["-1", "1.5", "bad", "9007199254740992"])(
    "rejects invalid durable replay cursor %s",
    async (cursor) => {
      expect(
        (
          await GET(
            new Request(`${url}/stream?afterSequence=${cursor}`),
            params,
          )
        ).status,
      ).toBe(400);
      expect(mocks.subscribe).not.toHaveBeenCalled();
    },
  );

  it("explicit stop aborts execution and preserves the partial answer", async () => {
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => {
      await text(options, "Partial answer");
      await new Promise<void>((resolve) =>
        assertDefined(options.signal).addEventListener(
          "abort",
          () => resolve(),
          {
            once: true,
          },
        ),
      );
    });
    const response = await POST(request(), params);
    await vi.waitFor(() => expect(mocks.runNative).toHaveBeenCalled());
    expect(await (await stop("old-turn")).json()).toEqual({
      stopRequested: false,
      turnId: "old-turn",
    });
    const stopped = await stop();
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toEqual({
      stopRequested: true,
      turnId: "turn-1",
    });
    expect(await response.text()).toContain('"type":"abort"');
    expect(mocks.finish).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      "cancelled",
      expect.any(String),
      "assistant-stable",
      [expect.objectContaining({ type: "text", text: "Partial answer" })],
      { leaseToken: "lease-1", generation: 1 },
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("never completes a model failure as success", async () => {
    mocks.runNative.mockImplementation(async (options: NativeRunOptions) => {
      await text(options, "Partial");
      throw new Error("Provider failed");
    });
    const response = await POST(request(), params);
    expect(await response.text()).toContain("Provider failed");
    expect(mocks.finish).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      "failed",
      "Provider failed",
      "assistant-stable",
      [expect.objectContaining({ type: "text", text: "Partial" })],
      { leaseToken: "lease-1", generation: 1 },
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([401, 404])(
    "rejects replay and cancellation without access (%s)",
    async (status) => {
      if (status === 401) mocks.resolveUser.mockResolvedValue(null);
      else mocks.getThread.mockResolvedValue(null);
      expect((await GET(new Request(`${url}/stream`), params)).status).toBe(
        status,
      );
      expect((await stop()).status).toBe(status);
    },
  );

  it("returns no stream for a different branch", async () => {
    const response = await POST(request(), params);
    await response.text();
    const thread = await mocks.getThread();
    mocks.getThread.mockResolvedValue({
      ...thread,
      branch: { ...thread.branch, activeMessageId: "other-branch" },
    });
    expect((await GET(new Request(`${url}/stream`), params)).status).toBe(204);
  });
  it("rejects unauthenticated, malformed and invalid submissions before creating a turn", async () => {
    mocks.resolveUser.mockResolvedValueOnce(null);
    expect((await POST(request(), params)).status).toBe(401);
    expect(
      (await POST(new Request(url, { method: "POST", body: "{" }), params))
        .status,
    ).toBe(400);
    for (const body of [
      {},
      { messages: [] },
      { messages: "invalid" },
      { messages: [], reasoningEffort: "ultra" },
    ]) {
      const response = await POST(
        new Request(url, { method: "POST", body: JSON.stringify(body) }),
        params,
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.runNative).not.toHaveBeenCalled();
  });

  it("conceals foreign threads and requires a configured model before starting execution", async () => {
    const thread = await mocks.getThread();
    mocks.getThread.mockResolvedValueOnce(null);
    expect((await POST(request(), params)).status).toBe(404);
    for (const assistant of [
      { ...thread.assistant, modelProvider: null },
      { ...thread.assistant, model: "" },
    ]) {
      mocks.getThread.mockResolvedValueOnce({ ...thread, assistant });
      const response = await POST(request(), params);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "This chat assistant has no model configured",
      });
    }
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected admission errors and never invokes the provider", async () => {
    mocks.begin.mockRejectedValueOnce(new Error("private persistence error"));
    const response = await POST(request(), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Chat request failed" });
    expect(mocks.runNative).not.toHaveBeenCalled();
  });

  it("validates cancellation bodies without stopping unrelated work", async () => {
    expect(
      (await DELETE(new Request(url, { method: "DELETE", body: "{" }), params))
        .status,
    ).toBe(400);
    for (const body of [null, "turn", {}, { turnId: 42 }, { turnId: "" }]) {
      const response = await DELETE(
        new Request(url, { method: "DELETE", body: JSON.stringify(body) }),
        params,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "A turn ID is required" });
    }
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
