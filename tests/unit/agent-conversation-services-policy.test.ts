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
  operateConversation,
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
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/agents/native", async (original) => ({
  ...(await original<typeof Native>()),
  runNativeAgent: mocks.run,
}));
vi.mock("@/lib/agents/mutations", () => ({ createConversation: mocks.create }));
vi.mock("@/lib/agents/queries", () => ({ getAgentForRun: mocks.agent }));

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
    runtimeSessionKey: null as string | null,
    publicApiConversation: null as { id: string } | null,
    workSession: null as {
      id: string;
      title: string;
      task: string | null;
    } | null,
    agent: {
      provider: provider as typeof provider | null,
      model: "model" as string | null,
      modelProviders: [] as { provider: typeof provider }[],
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
const callOperation = (action: "compact" | "new" = "compact", extra = {}) =>
  operateConversation({
    workspaceId: "workspace",
    agentId: "agent",
    conversationId: "conversation",
    action,
    ...extra,
  });

beforeEach(() => {
  vi.resetAllMocks();
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
    provider,
    model: "model",
    modelProviders: [],
    runtimeKind: "pi",
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

  it("uses valid workspace title models ahead of agent providers", async () => {
    const row = conversation();
    Object.assign(row.agent.workspace, {
      titleModelProviderId: "title",
      titleModel: "missing",
      defaultModelProviderId: "default",
      defaultModel: "model",
    });
    mocks.db.conversation.findFirst.mockResolvedValue(row);
    mocks.db.modelProvider.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(provider);
    expect(await callTitle()).toBe("Generated title");
    expect(mocks.db.modelProvider.findFirst).toHaveBeenCalledTimes(2);
  });

  it("falls back to linked providers and rejects missing models", async () => {
    const row = conversation();
    row.agent.provider = null;
    row.agent.model = null;
    row.agent.modelProviders = [
      { provider: { ...provider, models: [] } },
      { provider },
    ];
    mocks.db.conversation.findFirst.mockResolvedValue(row);
    expect(await callTitle()).toBe("Generated title");
    row.agent.modelProviders = [];
    await expect(callTitle()).rejects.toThrow("No model is configured");
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

describe("conversation operation admission and compaction", () => {
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
    const release = acquireConversationOperation("conversation");
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
      const release = acquireConversationOperation("conversation");
      expect(release).not.toBeNull();
      release?.();
    },
  );

  it("only creates new sessions for existing channel connections", async () => {
    await expect(callOperation("new")).rejects.toMatchObject({
      code: "notChannel",
      status: 400,
    });
    mocks.db.conversation.findFirst.mockResolvedValue({
      ...conversation(),
      title: null,
      runtimeSessionKey: "channel:connection:chat",
    });
    mocks.db.agentChannelConnection.findFirst.mockResolvedValue(null);
    await expect(callOperation("new")).rejects.toMatchObject({
      code: "notFound",
    });
    mocks.db.agentChannelConnection.findFirst.mockResolvedValue({
      id: "connection",
    });
    mocks.create
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "new" });
    await expect(callOperation("new")).rejects.toMatchObject({
      code: "notFound",
    });
    expect(await callOperation("new")).toEqual({
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

  it.each([
    { messages: [] },
    { messages: [{ id: "u", role: "user", parts: parts("hello") }] },
  ])("does not compact an incomplete exchange", async ({ messages }) => {
    mocks.db.message.findMany.mockResolvedValue(messages);
    expect(await callOperation()).toEqual({
      conversationId: "conversation",
      compacted: false,
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    "missing-agent",
    "missing-model",
    "empty-summary",
    "larger-summary",
    "changed",
    "success",
    "hermes",
    "aborted",
  ])("compaction outcome: %s", async (kind) => {
    const messages = [
      { id: "u1", role: "user", parts: parts("Question ".repeat(300)) },
      { id: "a1", role: "assistant", parts: parts("Answer ".repeat(300)) },
      { id: "u2", role: "user", parts: parts("Keep this last exchange") },
    ];
    mocks.db.message.findMany.mockResolvedValue(messages);
    mocks.db.message.findFirst.mockResolvedValue({
      id: kind === "changed" ? "newer" : "u2",
    });
    mocks.run.mockResolvedValue(
      kind === "empty-summary"
        ? "  "
        : kind === "larger-summary"
          ? "expanded ".repeat(4000)
          : "summary",
    );
    if (kind === "missing-agent") mocks.agent.mockResolvedValue(null);
    if (kind === "missing-model")
      mocks.agent.mockResolvedValue({
        provider: null,
        model: null,
        modelProviders: [],
      });
    if (kind === "hermes")
      mocks.agent.mockResolvedValue({
        provider: null,
        model: null,
        modelProviders: [{ provider }],
        runtimeKind: "hermes",
      });
    const controller = new AbortController();
    if (kind === "aborted") controller.abort();
    const result = callOperation("compact", {
      signal: controller.signal,
      instructions: "retain decisions",
    });
    if (kind === "missing-agent")
      await expect(result).rejects.toMatchObject({ code: "notFound" });
    else if (kind === "missing-model")
      await expect(result).rejects.toMatchObject({ code: "noModel" });
    else if (kind === "empty-summary")
      await expect(result).rejects.toThrow("empty compaction summary");
    else if (kind === "changed")
      await expect(result).rejects.toMatchObject({ code: "changed" });
    else if (kind === "aborted")
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
    else {
      expect(await result).toMatchObject({
        compacted: kind !== "larger-summary",
      });
      if (kind !== "larger-summary") {
        expect(mocks.db.message.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              role: "system",
              parts: expect.arrayContaining([
                expect.objectContaining({
                  data: expect.objectContaining({
                    boundaryId: "a1",
                    summary: "summary",
                  }),
                }),
              ]),
            }),
          }),
        );
        expect(mocks.db.conversation.update).toHaveBeenCalledTimes(
          kind === "hermes" ? 1 : 0,
        );
      }
    }
    const release = acquireConversationOperation("conversation");
    expect(release).not.toBeNull();
    release?.();
  });
});
