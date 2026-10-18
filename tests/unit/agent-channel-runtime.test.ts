// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startAgentChannelRunner,
  stopAgentChannelRunner,
  liveAgentChannelStatus,
  reconcileAgentChannelRunners,
  shutdownAgentChannelRunners,
} from "@/lib/agents/channel-runtime";
import { getAgentChannelLogs } from "@/lib/agents/channel-runtime-logs";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  sandbox: vi.fn(),
  run: vi.fn(),
  spawn: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/lib/db", () => ({ db: { agentChannelConnection: mocks } }));
vi.mock("@/lib/agents/channels/create-adapter", () => ({
  createChannelAdapter: mocks.create,
}));
vi.mock("@/lib/agents/channel-sandboxes", () => ({
  getChannelSandbox: mocks.sandbox,
}));
vi.mock("@/lib/agents/message-service", () => ({
  runAgentChannelMessage: mocks.run,
}));
vi.mock("@/lib/agents/channel-connections", () => ({
  decryptChannelCredentials: mocks.credentials,
}));

function adapter() {
  return Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    sendTypingIndicator: vi.fn(async () => {}),
  });
}
const event = {
  chatId: "sender",
  userId: "sender",
  userName: "User",
  text: "Hello",
  messageId: "1",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TOOLPLANE_HERMES_ROOT", "");
  vi.stubEnv("HERMES_ROOT", "");
  globalThis.__toolplaneAgentChannelAdapters = undefined;
  globalThis.__toolplaneAgentChannelStarts = undefined;
  globalThis.__toolplaneAgentChannelLogs = undefined;
  mocks.credentials.mockReturnValue({
    WEIXIN_TOKEN: "bot-secret",
    WEIXIN_ACCOUNT_ID: "bot",
    WEIXIN_ALLOWED_USERS: "sender",
  });
  mocks.findFirst.mockResolvedValue({
    id: "connection",
    workspaceId: "workspace",
    sandboxId: "sandbox",
    agentId: "agent",
    platform: "weixin",
    credentials: {},
  });
  mocks.sandbox.mockResolvedValue({ id: "sandbox", agentId: "agent" });
  mocks.update.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.run.mockResolvedValue({
    status: 200,
    body: { delivery: "message", message: "Reply" },
  });
});
afterEach(async () => {
  for (const id of globalThis.__toolplaneAgentChannelAdapters?.keys() ?? [])
    await stopAgentChannelRunner("workspace", id);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("native channel lifecycle", () => {
  it("restores active channels without spawning Hermes or Python", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "missing", workspaceId: "workspace", platform: "weixin" },
      { id: "connection", workspaceId: "workspace", platform: "weixin" },
      { id: "callback", workspaceId: "workspace", platform: "whatsapp" },
    ]);
    mocks.findFirst.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValue(adapter());
    expect(await reconcileAgentChannelRunners()).toBe(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(liveAgentChannelStatus("connection")).toBe("starting");
  });

  it("deduplicates starts, redacts secrets, and ignores stale events after stop", async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    await Promise.all([
      startAgentChannelRunner("workspace", "connection"),
      startAgentChannelRunner("workspace", "connection"),
    ]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    transport.emit("statusChange", { connected: true });
    expect(liveAgentChannelStatus("connection")).toBe("running");
    transport.emit("log", { level: "error", message: "bad bot-secret" });
    expect(getAgentChannelLogs("connection").at(-1)?.message).toBe(
      "bad [REDACTED]",
    );
    transport.emit("message", { ...event, userId: "unauthorized" });
    expect(mocks.run).not.toHaveBeenCalled();
    transport.emit("message", event);
    await vi.waitFor(() =>
      expect(transport.sendMessage).toHaveBeenCalledWith(
        "sender",
        "Reply",
        expect.any(Object),
      ),
    );
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent",
        sandboxId: "sandbox",
        workspaceId: "workspace",
      }),
    );
    const signal = mocks.run.mock.calls[0][0].signal as AbortSignal;
    await stopAgentChannelRunner("workspace", "connection");
    expect(signal.aborted).toBe(true);
    expect(transport.disconnect).toHaveBeenCalledOnce();
    const updates = mocks.updateMany.mock.calls.length;
    transport.emit("statusChange", { connected: true });
    transport.emit("message", event);
    expect(liveAgentChannelStatus("connection")).toBe("stopped");
    expect(mocks.updateMany).toHaveBeenCalledTimes(updates);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("does not deliver the old turn after moving or stopping the channel", async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    let complete!: (value: unknown) => void;
    mocks.run.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await startAgentChannelRunner("workspace", "connection");
    transport.emit("message", event);
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    await stopAgentChannelRunner("workspace", "connection");
    complete({
      status: 200,
      body: { delivery: "message", message: "Old reply" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects missing sandbox assignments and cleans up a failed connection", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    expect(await startAgentChannelRunner("other", "connection")).toMatchObject({
      error: expect.any(String),
    });
    mocks.sandbox.mockResolvedValueOnce({ id: "sandbox", agentId: null });
    expect(
      await startAgentChannelRunner("workspace", "connection"),
    ).toMatchObject({ error: expect.stringContaining("Assign") });
    expect(mocks.create).not.toHaveBeenCalled();
    const transport = adapter();
    transport.connect.mockRejectedValueOnce(new Error("Invalid bot-secret"));
    mocks.create.mockResolvedValue(transport);
    expect(await startAgentChannelRunner("workspace", "connection")).toEqual({
      error: "Invalid [REDACTED]",
    });
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(liveAgentChannelStatus("connection")).toBe("stopped");
  });

  it("migrates stopped sandbox binding but rejects rebinding a live runner", async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    mocks.sandbox.mockResolvedValue({ id: "sandbox", agentId: "new-agent" });
    expect(await startAgentChannelRunner("workspace", "connection")).toEqual(
      {},
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "connection" },
      data: { agentId: "new-agent" },
    });
    mocks.sandbox.mockResolvedValue({ id: "sandbox", agentId: "third-agent" });
    expect(
      (await startAgentChannelRunner("workspace", "connection")).error,
    ).toContain("Stop the channel");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("rejects unbound agents, unsupported transports and missing start credentials", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      id: "connection",
      sandboxId: null,
      agentId: null,
      platform: "weixin",
    });
    expect(
      (await startAgentChannelRunner("workspace", "connection")).error,
    ).toContain("Bind an agent");
    for (const platform of ["unknown", "whatsapp"]) {
      mocks.findFirst.mockResolvedValueOnce({
        id: "connection",
        sandboxId: null,
        agentId: "agent",
        platform,
      });
      expect(
        (await startAgentChannelRunner("workspace", "connection")).error,
      ).toContain("no native");
    }
    mocks.credentials.mockReturnValue({});
    expect(
      (await startAgentChannelRunner("workspace", "connection")).error,
    ).toContain("Missing required");
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "setup_required" }),
      }),
    );
  });

  it("keeps an already-running adapter and contains connection factory failures", async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    await startAgentChannelRunner("workspace", "connection");
    expect(await startAgentChannelRunner("workspace", "connection")).toEqual(
      {},
    );
    expect(mocks.create).toHaveBeenCalledOnce();
    await stopAgentChannelRunner("workspace", "connection");
    mocks.create.mockRejectedValueOnce("failure");
    expect(await startAgentChannelRunner("workspace", "connection")).toEqual({
      error: "Channel connection failed.",
    });
  });

  it("serializes same-thread turns, permits other threads and caps queued turns", async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    let release!: () => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ body: { delivery: "none" } });
        }),
    );
    await startAgentChannelRunner("workspace", "connection");
    for (let i = 0; i < 21; i++)
      transport.emit("message", { ...event, conversationId: "thread" });
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    expect(
      getAgentChannelLogs("connection").some((entry) =>
        entry.message.includes("queue is full"),
      ),
    ).toBe(true);
    await stopAgentChannelRunner("workspace", "connection");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("converts capped media into attachment parts and preserves command/thread reply semantics", async () => {
    const transport = adapter();
    transport.sendTypingIndicator.mockRejectedValue(new Error("no typing"));
    mocks.create.mockResolvedValue(transport);
    mocks.run.mockImplementation(async ({ onAccepted }) => {
      await onAccepted("Accepted");
      return { body: { delivery: "none" } };
    });
    await startAgentChannelRunner("workspace", "connection");
    transport.emit("message", {
      ...event,
      text: " ",
      conversationId: "thread",
      replyInThread: true,
      images: [{ data: "aQ==", media_type: "image/png" }],
      files: Array.from({ length: 25 }, () => ({
        data: "Zg==",
        media_type: "text/plain",
        filename: "x".repeat(300),
        size: 1,
      })),
    });
    await vi.waitFor(() =>
      expect(transport.sendMessage).toHaveBeenCalledWith("sender", "Accepted", {
        replyToMessageId: "1",
        replyInThread: true,
      }),
    );
    const request = mocks.run.mock.calls[0]?.[0];
    expect(request.attachmentParts).toHaveLength(20);
    expect(request.attachmentParts[0]).toEqual({
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,aQ==",
    });
    expect(request.rawBody).toMatchObject({
      message: "Attachment",
      source: { threadId: "thread" },
    });
    expect(request.rawBody.attachments[1].name).toHaveLength(240);
    for (const args of ["", "next"])
      transport.emit("command", { ...event, command: "new", args });
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(3));
    expect(mocks.run.mock.calls[1]?.[0].rawBody.message).toBe("/new");
    expect(mocks.run.mock.calls[2]?.[0].rawBody.message).toBe("/new next");
  });

  it.each([
    new Error("turn error"),
    "untyped failure",
    { body: { error: "provider rejected" } },
  ])(
    "logs turn failures without delivering an error as an agent answer: %j",
    async (failure) => {
      const transport = adapter();
      mocks.create.mockResolvedValue(transport);
      if (failure && typeof failure === "object" && "body" in failure)
        mocks.run.mockResolvedValue(failure);
      else mocks.run.mockRejectedValue(failure);
      await startAgentChannelRunner("workspace", "connection");
      transport.emit("message", event);
      await vi.waitFor(() =>
        expect(
          getAgentChannelLogs("connection").some(
            (entry) => entry.level === "error",
          ),
        ).toBe(true),
      );
      expect(transport.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("terminates fatal adapters and ignores their stale status/log/fatal events", async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    await startAgentChannelRunner("workspace", "connection");
    transport.emit("statusChange", {
      connected: false,
      error: "bad bot-secret",
    });
    transport.emit("log", { level: "debug", message: "diagnostic" });
    transport.emit("fatal", "fatal bot-secret");
    await vi.waitFor(() =>
      expect(mocks.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: "error",
            runnerPid: null,
            lastError: "fatal [REDACTED]",
          },
        }),
      ),
    );
    expect(liveAgentChannelStatus("connection")).toBe("stopped");
    const count = getAgentChannelLogs("connection").length;
    transport.emit("fatal", "stale");
    transport.emit("log", { level: "error", message: "stale" });
    transport.emit("statusChange", { connected: true });
    expect(getAgentChannelLogs("connection")).toHaveLength(count);
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it("stops bindings moved by another operation and contains disconnect failures", async () => {
    vi.useFakeTimers();
    const transport = adapter();
    transport.disconnect.mockRejectedValue(new Error("disconnect rejected"));
    mocks.create.mockResolvedValue(transport);
    await startAgentChannelRunner("workspace", "connection");
    mocks.findFirst.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(liveAgentChannelStatus("connection")).toBe("stopped");
    expect(
      getAgentChannelLogs("connection").some(
        (entry) => entry.message === "Channel disconnect failed.",
      ),
    ).toBe(true);
  });

  it("times out a hung connection and releases resources", async () => {
    vi.useFakeTimers();
    const transport = adapter();
    transport.connect.mockImplementation(() => new Promise(() => {}));
    mocks.create.mockResolvedValue(transport);
    const result = startAgentChannelRunner("workspace", "connection");
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toEqual({ error: "Channel connection timed out." });
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it("shuts down without overwriting persisted running status", async () => {
    const transport = adapter();
    mocks.create.mockResolvedValue(transport);
    await startAgentChannelRunner("workspace", "connection");
    const writes = mocks.updateMany.mock.calls.length;
    await shutdownAgentChannelRunners();
    expect(liveAgentChannelStatus("connection")).toBe("stopped");
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(mocks.updateMany).toHaveBeenCalledTimes(writes);
  });
});
