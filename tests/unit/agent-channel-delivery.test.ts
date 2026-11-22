// @vitest-environment node
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  createAdapter: vi.fn(),
  log: vi.fn(() => "Channel operation failed."),
  connection: vi.fn(),
  update: vi.fn(async () => ({ count: 1 })),
  admit: vi.fn(),
  persist: vi.fn(),
  attachments: vi.fn(),
  readAttachment: vi.fn(),
  payload: null as unknown,
  handler: null as ((payload: unknown) => Promise<unknown>) | null,
  pending: new Set<Promise<unknown>>(),
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: vi.fn(),
  runtimeCanOperate: () => true,
}));
vi.mock("@/lib/db", () => ({
  db: {
    workspaceAttachment: { findMany: mocks.attachments },
    agentChannelConnection: {
      findFirst: mocks.connection,
      updateMany: mocks.update,
    },
    agent: {
      findFirst: async () => ({
        runtimeKind: "pi-sdk",
        currentRevisionVersion: 1,
      }),
    },
  },
}));
vi.mock(import("@/lib/attachments/storage"), async (importOriginal) => ({
  ...(await importOriginal()),
  readWorkspaceAttachment: mocks.readAttachment,
}));
vi.mock("@/lib/agents/channel-connections", () => ({
  decryptChannelCredentials: () => ({}),
}));
vi.mock("@/lib/agents/platform-runner", () => ({
  hostedRunnerSpec: () => ({}),
}));
vi.mock("@/lib/agents/platforms", () => ({
  getMessagingPlatform: () => ({ credentials: [] }),
  missingStartCredentialNames: () => [],
}));
vi.mock("@/lib/agents/channel-runtime-logs", () => ({
  appendAgentChannelLog: mocks.log,
}));
vi.mock("@/lib/agents/channel-sender-access", () => ({
  admitChannelSender: mocks.admit,
}));
// Transport-only tests stub the queue boundary; real lease recovery/deduplication
// is covered against Postgres in agent-channel-sessions.test.ts.
vi.mock("@/lib/agents/channel-inbound-queue", () => ({
  channelInboundDedupeKey: (messageId: string) => messageId,
  persistChannelInboundEvent: mocks.persist,
  registerChannelInboundHandler: (
    _connectionId: string,
    handler: (payload: unknown) => Promise<unknown>,
  ) => {
    mocks.handler = handler;
    return () => {
      if (mocks.handler === handler) mocks.handler = null;
    };
  },
  processChannelInboundQueue: async () => {
    const operation = mocks.handler?.(mocks.payload).catch(() => {});
    if (!operation) return;
    mocks.pending.add(operation);
    try {
      await operation;
    } finally {
      mocks.pending.delete(operation);
    }
  },
  recoverChannelInboundEvents: async () => {},
  startChannelInboundRecovery: () => {},
  stopChannelInboundRecovery: async () => {
    await Promise.allSettled([...mocks.pending]);
  },
}));
vi.mock("@/lib/agents/channel-sandboxes", () => ({
  getChannelSandbox: vi.fn(),
}));
vi.mock("@/lib/agents/channels/create-adapter", () => ({
  createChannelAdapter: mocks.createAdapter,
}));
vi.mock("@/lib/agents/message-service", () => ({
  runAgentChannelMessage: mocks.run,
  CHANNEL_EXECUTION_FAILURE_MESSAGE:
    "本次执行未能完成，未自动重试。请在工作区查看会话执行状态，检查模型或工具连接后再发送新消息。",
}));
import {
  startAgentChannelRunner,
  shutdownAgentChannelRunners,
} from "@/lib/agents/channel-runtime";
import { CHANNEL_EXECUTION_FAILURE_MESSAGE } from "@/lib/agents/message-service";

class TestAdapter extends EventEmitter {
  supportsFileDelivery = false;
  sendFile = vi.fn(async () => {});
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  sendTypingIndicator = vi.fn(async () => {});
  sendMessage = vi.fn(
    async (_chatId: string, _text: string, _options?: unknown) => {},
  );
  onTextUpdate = vi.fn(
    async (_chatId: string, _text: string, _options?: unknown) => {},
  );
  onStreamComplete = vi.fn(
    async (_chatId: string, _text: string, _options?: unknown) => true,
  );
  onStreamSegment = vi.fn(
    async (_chatId: string, _text: string, _options?: unknown) => true,
  );
  onStreamError = vi.fn(
    async (_chatId: string, _error: string, _options?: unknown) => {},
  );
}
let adapter: TestAdapter;
const incoming = () =>
  adapter.emit("message", {
    chatId: "chat",
    chatType: "dm",
    userId: "sender",
    userName: "Sender",
    text: "hi",
    messageId: "message-1",
  });
const drain = async () => {
  await setImmediate();
  await Promise.allSettled([...mocks.pending]);
};
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.admit.mockResolvedValue({ allowed: true, role: "user" });
  mocks.persist.mockImplementation(async (input) => {
    mocks.payload = input.payload;
    return { event: { queueKey: input.queueKey }, duplicate: false };
  });
  adapter = new TestAdapter();
  mocks.createAdapter.mockResolvedValue(adapter);
  mocks.connection.mockResolvedValue({
    id: "channel",
    workspaceId: "workspace",
    agentId: "agent",
    sandboxId: null,
    platform: "weixin",
    credentials: {},
    groupSessionsPerUser: true,
    threadSessionsPerUser: false,
  });
  mocks.run.mockResolvedValue({
    status: 200,
    body: { delivery: "message", message: "Actual reply", files: [] },
  });
  expect(await startAgentChannelRunner("workspace", "channel")).toEqual({});
});
afterEach(async () => {
  await shutdownAgentChannelRunners();
});

describe("channel upstream execution delivery", () => {
  it("sends the actual normal reply once without eager acceptance receipts", async () => {
    incoming();
    await drain();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage.mock.calls[0]?.[1]).toBe("Actual reply");
  });

  it("persists admitted events before executing and carries the adapter source context", async () => {
    incoming();
    await drain();
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "channel",
        workspaceId: "workspace",
        dedupeKey: "message-1",
        kind: "hosted",
      }),
    );
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundPersisted: true,
        hostedIngress: true,
        rawBody: expect.objectContaining({
          source: expect.objectContaining({ chatType: "dm", userId: "sender" }),
        }),
      }),
    );
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0],
    );
  });

  it("delivers an admission reply without persisting or executing the rejected sender", async () => {
    mocks.admit.mockResolvedValueOnce({
      allowed: false,
      rule: "user_not_allowed",
      reply: "Approval code: ABCDEFGH",
    });
    incoming();
    await drain();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "chat",
      "Approval code: ABCDEFGH",
      { replyToMessageId: "message-1" },
    );
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it.each(["rejected", "error-response"])(
    "sends one safe actionable failure for %s",
    async (mode) => {
      if (mode === "rejected")
        mocks.run.mockRejectedValueOnce(
          new Error("Bearer secret /internal/private.js stack trace"),
        );
      else
        mocks.run.mockResolvedValueOnce({
          status: 502,
          body: { error: "Bearer secret /internal/private.js" },
        });
      incoming();
      await drain();
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(adapter.sendMessage.mock.calls[0]?.[1]).toBe(
        CHANNEL_EXECUTION_FAILURE_MESSAGE,
      );
      expect(adapter.sendMessage.mock.calls[0]?.[1]).not.toMatch(
        /Bearer|secret|internal|stack/,
      );
    },
  );

  it("forwards a native dialog notification before the final reply", async () => {
    const notice =
      "Pi 扩展需要你的输入，请打开会话：/app/workspace/work?agent=agent&c=conversation";
    mocks.run.mockImplementationOnce(async (input) => {
      expect(adapter.sendMessage).not.toHaveBeenCalled();
      await input.onUiRequired(notice);
      return {
        status: 200,
        body: { delivery: "message", message: "Actual reply", files: [] },
      };
    });
    incoming();
    await drain();
    expect(adapter.sendMessage.mock.calls.map((call) => call[1])).toEqual([
      notice,
      "Actual reply",
    ]);
  });

  it("continues observing and delivers the final reply when native UI notification sending fails", async () => {
    const notice =
      "Pi 扩展需要你的输入，请打开会话：/app/workspace/work?agent=agent&c=conversation";
    adapter.sendMessage.mockRejectedValueOnce(
      new Error("Native UI transport unavailable"),
    );
    mocks.run.mockImplementationOnce(async (input) => {
      await input.onUiRequired(notice);
      expect(input.signal.aborted).toBe(false);
      return {
        status: 200,
        body: { delivery: "message", message: "Actual reply", files: [] },
      };
    });
    incoming();
    await drain();
    expect(adapter.sendMessage.mock.calls.map((call) => call[1])).toEqual([
      notice,
      "Actual reply",
    ]);
    expect(mocks.log).toHaveBeenCalledWith(
      "channel",
      "error",
      "Native UI notification could not be delivered.",
      [],
    );
    expect(adapter.sendMessage.mock.calls.map((call) => call[1])).not.toContain(
      CHANNEL_EXECUTION_FAILURE_MESSAGE,
    );
  });

  it("does not turn a failed outbound send into a second misleading reply", async () => {
    adapter.sendMessage.mockRejectedValueOnce(
      new Error("Transport unavailable"),
    );
    incoming();
    await drain();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage.mock.calls[0]?.[1]).toBe("Actual reply");
  });

  it("detaches on shutdown without sending a false execution failure", async () => {
    let signal: AbortSignal | undefined;
    const observing = Promise.withResolvers<void>();
    mocks.run.mockImplementationOnce((input) => {
      signal = input.signal;
      const detached = Promise.withResolvers<never>();
      input.signal.addEventListener(
        "abort",
        () => detached.reject(new DOMException("Detached", "AbortError")),
        { once: true },
      );
      observing.resolve();
      return detached.promise;
    });
    incoming();
    await observing.promise;
    await shutdownAgentChannelRunners();
    expect(signal?.aborted).toBe(true);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  describe("reply files", () => {
    const bytes = Uint8Array.of(0, 128, 255);
    const file = {
      attachmentId: "artifact-1",
      filename: "report.pdf",
      mediaType: "application/pdf",
      size: bytes.length,
    };
    const detailUrl =
      "https://toolplane.example/app/workspace/work?c=conversation";
    const body = {
      conversationId: "conversation",
      delivery: "silent",
      message: "",
      files: [file],
      detailUrl,
    };
    const storagePath =
      "objects/00000000-0000-4000-8000-000000000001-report.pdf";
    beforeEach(() => {
      mocks.attachments.mockResolvedValue([
        {
          id: file.attachmentId,
          storagePath,
          size: file.size,
          name: file.filename,
          mimeType: file.mediaType,
        },
      ]);
      mocks.readAttachment.mockImplementation(() => new Response(bytes).body);
    });

    it("delivers a silent file-only reply as native bytes without a text receipt", async () => {
      adapter.supportsFileDelivery = true;
      mocks.run.mockResolvedValueOnce({ status: 200, body });
      incoming();
      await drain();
      expect(mocks.attachments).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: "workspace",
            status: "ready",
            origin: "artifact",
            id: { in: [file.attachmentId] },
          }),
        }),
      );
      expect(mocks.readAttachment).toHaveBeenCalledWith(
        "workspace",
        storagePath,
        expect.any(Number),
      );
      expect(adapter.sendFile.mock.calls).toEqual([
        [
          "chat",
          {
            data: "AID/",
            media_type: file.mediaType,
            filename: file.filename,
            size: file.size,
          },
        ],
      ]);
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("sends one linked summary after the reply for a non-native transport", async () => {
      mocks.run.mockResolvedValueOnce({
        status: 200,
        body: {
          ...body,
          delivery: "message",
          message: "Done",
          fallbackFilenames: ["chart.png"],
        },
      });
      incoming();
      await drain();
      const calls = adapter.sendMessage.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]?.slice(0, 2)).toEqual(["chat", "Done"]);
      expect(calls[1]?.slice(0, 2)).toEqual([
        "chat",
        `已生成 2 个文件：report.pdf、chart.png\n在 ToolPlane 中查看（需登录）：${detailUrl}`,
      ]);
      expect(adapter.sendFile).not.toHaveBeenCalled();
      expect(mocks.readAttachment).not.toHaveBeenCalled();
    });

    it("summarizes a fallback-only silent reply even without a persistent attachment or link", async () => {
      adapter.supportsFileDelivery = true;
      mocks.run.mockResolvedValueOnce({
        status: 200,
        body: {
          ...body,
          files: [],
          detailUrl: undefined,
          fallbackFilenames: ["chart.png"],
        },
      });
      incoming();
      await drain();
      expect(adapter.sendMessage.mock.calls.map(([, text]) => text)).toEqual([
        "已生成 1 个文件：chart.png",
      ]);
      expect(adapter.sendFile).not.toHaveBeenCalled();
    });

    it("delivers the file after successfully finalizing a streamed reply", async () => {
      adapter.supportsFileDelivery = true;
      mocks.run.mockImplementationOnce(async (input) => {
        input.onReplySegments(["Preparing the report for delivery now."]);
        await setImmediate();
        return {
          status: 200,
          body: { ...body, delivery: "message", message: "Done" },
        };
      });
      incoming();
      await drain();
      expect(adapter.onStreamComplete).toHaveBeenCalledWith(
        "chat",
        "Done",
        expect.anything(),
      );
      expect(adapter.sendFile).toHaveBeenCalledTimes(1);
      expect(adapter.onStreamComplete.mock.invocationCallOrder[0]).toBeLessThan(
        adapter.sendFile.mock.invocationCallOrder[0],
      );
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("does not deliver or summarize artifacts attached to a failed response", async () => {
      adapter.supportsFileDelivery = true;
      mocks.run.mockResolvedValueOnce({
        status: 200,
        body: {
          ...body,
          delivery: "message",
          message: "Execution failed",
          failed: true,
          fallbackFilenames: ["chart.png"],
        },
      });
      incoming();
      await drain();
      expect(adapter.sendMessage.mock.calls.map(([, text]) => text)).toEqual([
        "Execution failed",
      ]);
      expect(adapter.sendFile).not.toHaveBeenCalled();
      expect(mocks.readAttachment).not.toHaveBeenCalled();
    });
  });

  describe("live progress", () => {
    const progress = "Cloning the repository and reading the README now.";
    const runWithProgress = (body: Record<string, unknown>, text = progress) =>
      mocks.run.mockImplementationOnce(async (input) => {
        input.onReplySegments?.([text]);
        await setImmediate();
        return { status: 200, body: { files: [], ...body } };
      });

    it("edits progress into one message and finalizes it with the reply", async () => {
      runWithProgress({ delivery: "message", message: "Actual reply" });
      incoming();
      await drain();
      expect(adapter.onTextUpdate).toHaveBeenCalledWith(
        "chat",
        progress,
        expect.anything(),
      );
      expect(adapter.onStreamComplete).toHaveBeenCalledWith(
        "chat",
        "Actual reply",
        expect.anything(),
      );
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("finalizes text before each tool call as its own message", async () => {
      const before = "Cloning the repository to verify the target commit.";
      const after = "Repo cloned. The target tip is c4b73cb, all checks pass.";
      mocks.run.mockImplementationOnce(async (input) => {
        input.onReplySegments?.([before]);
        await setImmediate();
        input.onReplySegments?.([before, after]);
        await setImmediate();
        return {
          status: 200,
          body: {
            delivery: "message",
            message: `${before}\n\n${after}`,
            files: [],
          },
        };
      });
      incoming();
      await drain();
      expect(adapter.onTextUpdate.mock.calls.map((call) => call[1])).toEqual([
        before,
        after,
      ]);
      expect(adapter.onStreamSegment).toHaveBeenCalledWith(
        "chat",
        before,
        expect.anything(),
      );
      expect(adapter.onStreamComplete).toHaveBeenCalledWith(
        "chat",
        after,
        expect.anything(),
      );
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("sends the reply normally when the platform cannot finalize the stream", async () => {
      adapter.onStreamComplete.mockResolvedValueOnce(false);
      runWithProgress({ delivery: "message", message: "Actual reply" });
      incoming();
      await drain();
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(adapter.sendMessage.mock.calls[0]?.[1]).toBe("Actual reply");
    });

    it("appends a coded failure to the streamed progress", async () => {
      const failure =
        "本次执行未能完成（PI_TASK_MODEL_TIMEOUT）：任务总时限已到。";
      runWithProgress({ delivery: "message", message: failure, failed: true });
      incoming();
      await drain();
      expect(adapter.onStreamError).toHaveBeenCalledWith(
        "chat",
        failure,
        expect.anything(),
      );
      expect(adapter.onStreamComplete).not.toHaveBeenCalled();
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("never shows text that may still become a silent reply", async () => {
      runWithProgress({ delivery: "silent", message: "" }, "NO_REPLY");
      incoming();
      await drain();
      expect(adapter.onTextUpdate).not.toHaveBeenCalled();
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });
  });
});
