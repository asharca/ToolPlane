import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Native from "@/lib/agents/native";
import {
  generateConsoleConversationTitle,
  generateWorkSessionTitle,
  normalizeGeneratedConversationTitle,
} from "@/lib/agents/conversation-naming";
import {
  acquireConversationOperation,
  conversationOperationKey,
  rotateChannelConversation,
  waitForConversationOperation,
} from "@/lib/agents/conversation-operations";

const mocks = vi.hoisted(() => ({
  db: {
    conversation: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    message: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    modelProvider: { findFirst: vi.fn() },
    workSession: { findUnique: vi.fn(), updateMany: vi.fn() },
    agentChannelConnection: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  run: vi.fn(),
  create: vi.fn(),
  agent: vi.fn(),
  pinned: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/agents/native", async (original) => ({
  ...(await original<typeof Native>()),
  runNativeAgent: mocks.run,
}));
vi.mock("@/lib/agents/mutations", () => ({ createConversation: mocks.create }));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRun: mocks.agent }));
vi.mock("@/lib/agents/revisions", () => ({ resolvePinnedAgent: mocks.pinned }));

const provider = {
  id: "provider",
  name: "Provider",
  format: "openai",
  models: ["model"],
  baseUrl: "https://model.invalid",
  apiKey: "secret",
};
function conversation() {
  return {
    id: "conversation",
    title: "First question" as string | null,
    agentRevisionId: "session-revision",
    legacyRevisionUnresolved: false,
    runtimeSessionKey: "channel:connection:chat" as string | null,
    publicApiConversation: null as { id: string } | null,
    workSession: null as {
      id: string;
      title: string;
      task: string | null;
    } | null,
    agent: {
      provider: provider as typeof provider | null,
      model: "model" as string | null,
      workspace: {
        titleModelProviderId: null as string | null,
        titleModel: null as string | null,
        defaultModelProviderId: null as string | null,
        defaultModel: null as string | null,
      },
    },
  };
}
const parts = (text: string) => [{ type: "text", text }];
const callTitle = (force = false) =>
  generateConsoleConversationTitle("workspace", "agent", "conversation", force);
const callOperation = () =>
  rotateChannelConversation({
    workspaceId: "workspace",
    agentId: "agent",
    conversationId: "conversation",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pinned.mockImplementation(async (agent) => agent);
  mocks.db.conversation.findFirst.mockResolvedValue(conversation());
  mocks.db.message.findFirst.mockResolvedValue({
    parts: parts("First question"),
  });
  mocks.db.message.findMany.mockResolvedValue([
    { id: "assistant", role: "assistant", parts: parts("An answer") },
    { id: "user", role: "user", parts: parts("First question") },
  ]);
  mocks.db.conversation.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.workSession.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.db) => Promise<unknown>) =>
      callback(mocks.db),
  );
  mocks.run.mockResolvedValue("Generated title");
  mocks.agent.mockResolvedValue({
    id: "agent",
    workspaceId: "workspace",
    retiredAt: null,
    provider,
    model: "model",
    runtimeKind: "pi-sdk",
  });
});

describe("conversation title input and concurrent updates", () => {
  it.each([
    ["", 64, null],
    [" \n\r\n", 64, null],
    ["Title", 0, null],
    ["\n Title: Useful result!!!\nignored", 64, "Useful result"],
    ["标题：你好。", 64, "你好"],
    ["```text Short title```", 64, "Short title"],
    ["'😀😀😀'", 2, "😀😀"],
    ["!!!", 64, null],
  ])("normalizes %j with limit %i", (input, limit, expected) => {
    expect(normalizeGeneratedConversationTitle(input, limit)).toBe(expected);
  });

  it.each(["missing", "channel", "public", "work"])(
    "rejects ineligible console conversation: %s",
    async (kind) => {
      const row = conversation();
      if (kind === "channel") row.title = "msg:source";
      if (kind === "public") row.publicApiConversation = { id: "api" };
      if (kind === "work")
        row.workSession = { id: "work", title: "task", task: "task" };
      mocks.db.conversation.findFirst.mockResolvedValue(
        kind === "missing" ? null : row,
      );
      expect(await callTitle(true)).toBeNull();
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );

  it("does not rename manually edited titles or console chats through the work entry point", async () => {
    const row = conversation();
    row.title = "Manually named";
    mocks.db.conversation.findFirst.mockResolvedValue(row);
    expect(await callTitle()).toBeNull();
    expect(
      await generateWorkSessionTitle("workspace", "agent", row.id),
    ).toBeNull();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    { messages: [] },
    { messages: [{ role: "user", parts: parts("only question") }] },
    { messages: [{ role: "assistant", parts: parts("only answer") }] },
  ])(
    "needs both sides of a meaningful transcript: %j",
    async ({ messages }) => {
      mocks.db.message.findMany.mockResolvedValue(messages);
      expect(await callTitle(true)).toBeNull();
    },
  );

  it("serializes files, merges adjacent turns, drops invalid parts and keeps the latest five turns", async () => {
    mocks.db.message.findMany.mockResolvedValue([
      { role: "assistant", parts: parts("final") },
      {
        role: "user",
        parts: [
          { type: "file", filename: " report.pdf " },
          null,
          1,
          { type: "text", text: false },
        ],
      },
      { role: "user", parts: parts("more") },
      { role: "assistant", parts: parts("earlier") },
      { role: "user", parts: parts("question") },
      { role: "assistant", parts: parts("old") },
      { role: "user", parts: parts("discarded") },
      { role: "user", parts: {} },
    ]);
    expect(await callTitle(true)).toBe("Generated title");
    const input = mocks.run.mock.calls[0][0].messages[0].content as string;
    expect(JSON.parse(input)).toEqual([
      { role: "assistant", content: "old" },
      { role: "user", content: "question" },
      { role: "assistant", content: "earlier" },
      { role: "user", content: "more\n[File: report.pdf]" },
      { role: "assistant", content: "final" },
    ]);
  });

  it("fails closed on revoked pinned model grants without using workspace defaults", async () => {
    mocks.pinned.mockRejectedValueOnce(new Error("Pinned provider revoked"));
    await expect(callTitle()).rejects.toThrow("Pinned provider revoked");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.db.modelProvider.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a missing pinned model rather than using workspace defaults", async () => {
    mocks.pinned.mockResolvedValueOnce({
      provider: null,
      model: null,
    });
    await expect(callTitle()).rejects.toThrow(
      "No model is configured in the pinned revision",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("does not write empty model titles or overwrite concurrent console renames", async () => {
    mocks.run.mockResolvedValueOnce("   ");
    expect(await callTitle()).toBeNull();
    expect(mocks.db.conversation.updateMany).not.toHaveBeenCalled();
    mocks.db.conversation.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await callTitle()).toBeNull();
  });

  it.each([
    "success",
    "conversation-conflict",
    "work-conflict",
    "error",
    "manual",
    "no-task",
  ])("handles paired work title update: %s", async (kind) => {
    const row = conversation();
    row.workSession = {
      id: "work",
      task: "First question",
      title: "First question",
    };
    if (kind === "manual") row.workSession.title = "Manual";
    if (kind === "no-task") row.workSession.task = null;
    mocks.db.conversation.findFirst.mockResolvedValue(row);
    if (kind === "conversation-conflict")
      mocks.db.conversation.updateMany.mockResolvedValue({ count: 0 });
    if (kind === "work-conflict")
      mocks.db.workSession.updateMany.mockResolvedValue({ count: 0 });
    if (kind === "error")
      mocks.db.workSession.updateMany.mockRejectedValue(
        new Error("database unavailable"),
      );
    const pending = generateWorkSessionTitle("workspace", "agent", row.id);
    if (kind === "error")
      await expect(pending).rejects.toThrow("database unavailable");
    else
      expect(await pending).toBe(kind === "success" ? "Generated title" : null);
  });
});

describe("conversation admission and channel session rotation", () => {
  it("shares channel locks, keeps ordinary sessions separate and releases idempotently", () => {
    expect(
      conversationOperationKey({ id: "a", runtimeSessionKey: "channel:x" }),
    ).toBe("channel:x");
    expect(
      conversationOperationKey({ id: "a", runtimeSessionKey: "other" }),
    ).toBe("a");
    expect(conversationOperationKey({ id: "a" })).toBe("a");
    const release = acquireConversationOperation("lock-test");
    expect(release).not.toBeNull();
    expect(acquireConversationOperation("lock-test", "compact")).toBeNull();
    release?.();
    release?.();
    acquireConversationOperation("lock-test")?.();
  });

  it("queues turns in order, drops canceled waiters, and does not block other conversations", async () => {
    const first = acquireConversationOperation("queued-conversation");
    const canceled = new AbortController();
    const waitingCanceled = waitForConversationOperation(
      "queued-conversation",
      canceled.signal,
    );
    const rejection = expect(waitingCanceled).rejects.toThrow("canceled");
    const order: string[] = [];
    const second = waitForConversationOperation("queued-conversation").then(
      (release) => {
        order.push("second");
        return release;
      },
    );
    const third = waitForConversationOperation("queued-conversation").then(
      (release) => {
        order.push("third");
        return release;
      },
    );
    const other = await waitForConversationOperation(
      "independent-conversation",
    );
    other();
    canceled.abort(new Error("canceled"));
    await rejection;
    expect(order).toEqual([]);
    first?.();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    expect(
      acquireConversationOperation("queued-conversation", "compact"),
    ).toBeNull();
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    releaseThird();
    acquireConversationOperation("queued-conversation")?.();
  });

  it.each([
    null,
    { ...conversation(), publicApiConversation: { id: "public" } },
  ])("hides unavailable conversations", async (row) => {
    mocks.db.conversation.findFirst.mockResolvedValue(row);
    await expect(callOperation()).rejects.toMatchObject({
      code: "notFound",
      status: 404,
    });
  });

  it("rejects a competing operation without releasing its lock", async () => {
    const release = acquireConversationOperation("channel:connection:chat");
    try {
      await expect(callOperation()).rejects.toMatchObject({ code: "busy" });
    } finally {
      release?.();
    }
  });

  it.each(["queued", "running", "waiting_approval", "cancelling"])(
    "rejects %s work and releases admission",
    async (status) => {
      mocks.db.conversation.findFirst.mockResolvedValue({
        ...conversation(),
        workSession: { id: "work" },
      });
      mocks.db.workSession.findUnique.mockResolvedValue({ status });
      await expect(callOperation()).rejects.toMatchObject({ code: "busy" });
      const release = acquireConversationOperation("channel:connection:chat");
      expect(release).not.toBeNull();
      release?.();
    },
  );

  it("only creates new sessions for existing channel connections", async () => {
    mocks.db.conversation.findFirst.mockResolvedValueOnce({
      ...conversation(),
      runtimeSessionKey: null,
    });
    await expect(callOperation()).rejects.toMatchObject({
      code: "notChannel",
      status: 400,
    });
    mocks.db.conversation.findFirst.mockResolvedValue({
      ...conversation(),
      title: null,
      runtimeSessionKey: "channel:connection:chat",
    });
    mocks.db.agentChannelConnection.findFirst.mockResolvedValue(null);
    await expect(callOperation()).rejects.toMatchObject({
      code: "notFound",
    });
    mocks.db.agentChannelConnection.findFirst.mockResolvedValue({
      id: "connection",
    });
    mocks.create
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "new" });
    await expect(callOperation()).rejects.toMatchObject({
      code: "notFound",
    });
    expect(await callOperation()).toEqual({
      conversationId: "new",
      compacted: false,
    });
    expect(mocks.create).toHaveBeenLastCalledWith(
      "workspace",
      "agent",
      undefined,
      { runtimeSessionKey: "channel:connection:chat" },
    );
  });

  it.each(["legacy", "missing-pin", "unresolved", "retired"])(
    "never rotates historical %s sessions into executable state",
    async (condition) => {
      mocks.db.conversation.findFirst.mockResolvedValue({
        ...conversation(),
        ...(condition === "missing-pin" ? { agentRevisionId: null } : {}),
        ...(condition === "unresolved"
          ? { legacyRevisionUnresolved: true }
          : {}),
      });
      if (condition === "legacy")
        mocks.agent.mockResolvedValue({ runtimeKind: "hermes" });
      if (condition === "retired")
        mocks.agent.mockResolvedValue({
          runtimeKind: "pi-sdk",
          retiredAt: new Date(),
        });
      await expect(callOperation()).rejects.toMatchObject({
        code: "readOnly",
        status: 409,
      });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );
});
