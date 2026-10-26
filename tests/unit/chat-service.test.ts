// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  turnUpdateMany: vi.fn(),
  turnCreate: vi.fn(),
  turnFindFirst: vi.fn(),
  turnFindUniqueOrThrow: vi.fn(),
  turnUpdate: vi.fn(),
  runEventCreate: vi.fn(),
  assistantFindMany: vi.fn(),
  assistantFindFirst: vi.fn(),
  assistantUpdate: vi.fn(),
  assistantUpdateMany: vi.fn(),
  revisionCreate: vi.fn(),
  queryRaw: vi.fn(),
  messageCreate: vi.fn(),
  messageDelete: vi.fn(),
  messageFindMany: vi.fn(),
  threadFindFirst: vi.fn(),
  threadFindUnique: vi.fn(),
  threadUpdate: vi.fn(),
  threadUpdateMany: vi.fn(),
  threadDeleteMany: vi.fn(),
  messageFindFirst: vi.fn(),
  messageUpdate: vi.fn(),
  messageUpdateMany: vi.fn(),
  rootMessageUpdateMany: vi.fn(),
  attachmentUpdateMany: vi.fn(),
  attachmentFindUnique: vi.fn(),
}));

const tx = {
  $queryRaw: mocks.queryRaw,
  chatAssistant: {
    findFirst: mocks.assistantFindFirst,
    update: mocks.assistantUpdate,
    updateMany: mocks.assistantUpdateMany,
  },
  chatAssistantRevision: { create: mocks.revisionCreate },
  chatTurn: {
    create: mocks.turnCreate,
    findFirst: mocks.turnFindFirst,
    updateMany: mocks.turnUpdateMany,
    findUniqueOrThrow: mocks.turnFindUniqueOrThrow,
    update: mocks.turnUpdate,
  },
  chatRunEvent: { create: mocks.runEventCreate },
  chatMessage: {
    create: mocks.messageCreate,
    delete: mocks.messageDelete,
    findFirst: mocks.messageFindFirst,
    findMany: mocks.messageFindMany,
    update: mocks.messageUpdate,
    updateMany: mocks.messageUpdateMany,
  },
  chatThread: {
    findFirst: mocks.threadFindFirst,
    findUnique: mocks.threadFindUnique,
    update: mocks.threadUpdate,
    updateMany: mocks.threadUpdateMany,
    deleteMany: mocks.threadDeleteMany,
  },
  workspaceAttachment: {
    updateMany: mocks.attachmentUpdateMany,
    findUnique: mocks.attachmentFindUnique,
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    deployment: { findMany: vi.fn(async () => []) },
    chatTurn: {
      updateMany: mocks.turnUpdateMany,
      findFirst: mocks.turnFindFirst,
    },
    chatMessage: { updateMany: mocks.rootMessageUpdateMany },
    chatAssistant: {
      findMany: mocks.assistantFindMany,
      findFirst: mocks.assistantFindFirst,
    },
    chatThread: {
      findFirst: mocks.threadFindFirst,
      update: mocks.threadUpdate,
    },
  },
}));

import {
  beginChatTurn,
  ChatServiceError,
  completeChatTurn,
  finishChatTurn,
  getChatThreadForWorkspace,
  listChatAssistantsForWorkspace,
  reserveChatBranch,
  updateChatAssistant,
  updateChatThread,
  deleteReservedChatBranch,
  getChatHistoryForExecution,
  getChatTurnReplay,
  deleteChatThread,
} from "@/lib/chat/service";

describe("Chat turn admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:10:00.000Z"));
    mocks.threadFindFirst.mockResolvedValue({ id: "thread-1" });
    mocks.turnUpdateMany.mockResolvedValue({ count: 0 });
    mocks.turnFindUniqueOrThrow.mockResolvedValue({
      generation: 3,
      lastEventSequence: 7,
      stopRequestedAt: null,
    });
    mocks.turnUpdate.mockResolvedValue({ id: "turn-1" });
    mocks.runEventCreate.mockResolvedValue({ sequence: 8 });
    mocks.turnCreate.mockResolvedValue({
      id: "turn-1",
      threadId: "thread-1",
      status: "pending",
    });
    mocks.turnFindFirst.mockResolvedValue(null);
    mocks.threadDeleteMany.mockResolvedValue({ count: 1 });
    mocks.assistantFindMany.mockResolvedValue([]);
    mocks.assistantFindFirst.mockResolvedValue({ id: "assistant-2" });
    mocks.assistantUpdateMany.mockResolvedValue({ count: 1 });
    mocks.revisionCreate.mockResolvedValue({ id: "revision-2" });
    mocks.assistantUpdate.mockResolvedValue({
      id: "assistant-1",
      pinned: true,
      systemPrompt: null,
      modelProviderId: null,
      model: null,
      modelParameters: null,
      maxSteps: 5,
      mcpGrants: [],
    });
    mocks.queryRaw.mockResolvedValue([]);
    mocks.messageCreate.mockImplementation(
      async ({ data }: { data: { role: string } }) => ({
        id: data.role === "assistant" ? "assistant-1" : "user-1",
      }),
    );
    mocks.messageDelete.mockResolvedValue({ id: "message-1" });
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.messageFindFirst.mockReset().mockResolvedValue(null);
    mocks.messageUpdate.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ id: where.id }),
    );
    mocks.messageUpdateMany.mockResolvedValue({ count: 1 });
    mocks.rootMessageUpdateMany.mockResolvedValue({ count: 0 });
    mocks.threadFindUnique.mockResolvedValue({
      activeMessageId: null,
      title: null,
      workspaceId: "workspace-1",
      assistantRevisionId: "revision-1",
      legacyRevisionUnresolved: false,
    });
    mocks.threadUpdate.mockResolvedValue({ id: "thread-1" });
    mocks.threadUpdateMany.mockResolvedValue({ count: 1 });
    mocks.attachmentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps deletion authorization and Run safety checks inside the admission lock transaction", async () => {
    await deleteChatThread("user-1", "thread-1");
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.calls[0]?.[0].sql).toContain(
      'FROM "ChatThread"',
    );
    expect(mocks.queryRaw.mock.calls[0]?.[0].sql).toContain("FOR UPDATE");
    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        OR: [
          { status: "pending" },
          {
            confirmations: {
              some: { status: { in: ["executing", "execution_unknown"] } },
            },
          },
        ],
      },
      select: { id: true },
    });
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.turnFindFirst.mock.invocationCallOrder[0],
    );
    expect(mocks.turnFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.threadDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("retains thread history when a pending Run or unresolved external effect blocks deletion", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce({ id: "unresolved-effect" });
    await expect(deleteChatThread("user-1", "thread-1")).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.threadDeleteMany).not.toHaveBeenCalled();
  });

  it("does not inspect another user's execution ledger during deletion", async () => {
    mocks.threadFindFirst.mockResolvedValueOnce(null);
    await expect(deleteChatThread("other", "thread-1")).rejects.toMatchObject({
      status: 404,
    });
    expect(mocks.turnFindFirst).not.toHaveBeenCalled();
    expect(mocks.threadDeleteMany).not.toHaveBeenCalled();
  });

  it("only accepts completion from the current live fence", async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      completeChatTurn("thread-1", "turn-1", "assistant-1", [], {
        leaseToken: "lease",
        generation: 2,
      }),
    ).resolves.toBe(false);
    expect(mocks.turnUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "turn-1",
          threadId: "thread-1",
          status: "pending",
          leaseToken: "lease",
          generation: 2,
          leaseExpiresAt: { gt: new Date() },
        },
      }),
    );
    expect(mocks.messageUpdateMany).not.toHaveBeenCalled();
  });

  it("does not let unfenced completion claim leased work", async () => {
    await completeChatTurn("thread-1", "turn-1", "assistant-1", []);
    expect(mocks.turnUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "turn-1",
          threadId: "thread-1",
          status: "pending",
          leaseToken: null,
        },
      }),
    );
  });

  it("commits successful output under a live token and generation", async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      completeChatTurn(
        "thread-1",
        "turn-1",
        "assistant-1",
        [{ type: "text", text: "Saved" }],
        { leaseToken: "lease", generation: 3 },
      ),
    ).resolves.toBe(true);
    expect(mocks.turnUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "turn-1",
          threadId: "thread-1",
          status: "pending",
          leaseToken: "lease",
          generation: 3,
          leaseExpiresAt: { gt: new Date() },
        },
      }),
    );
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "success", parts: [{ type: "text", text: "Saved" }] },
      }),
    );
  });

  it("authorizes before locking and reserves stable user and assistant messages", async () => {
    await expect(
      beginChatTurn(
        "thread-1",
        [{ type: "text", text: "Hello" }],
        { workspaceId: "workspace-1", userId: "user-1" },
        { idempotencyKey: "request-1", modelId: "model-1" },
      ),
    ).resolves.toMatchObject({
      assistantMessageId: "assistant-1",
      assistantParentId: "user-1",
      historyLeafId: "user-1",
    });

    expect(mocks.threadFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.mock.invocationCallOrder[0],
    );
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.turnCreate).toHaveBeenCalledWith({
      data: {
        threadId: "thread-1",
        idempotencyKey: "request-1",
        actorUserId: "user-1",
        assistantRevisionId: "revision-1",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.turnFindFirst.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
        parentId: null,
        role: "user",
      }),
    });
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
        parentId: "user-1",
        role: "assistant",
        status: "pending",
        modelId: "model-1",
        parts: [],
      }),
    });
    expect(mocks.threadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeMessageId: "assistant-1" }),
      }),
    );
  });

  it("rejects an unauthorized thread before stale cleanup or a transaction", async () => {
    mocks.threadFindFirst.mockResolvedValueOnce(null);

    await expect(
      beginChatTurn(
        "thread-1",
        [{ type: "text", text: "Hello" }],
        {
          workspaceId: "workspace-1",
          userId: "user-1",
        },
        { idempotencyKey: "request-1" },
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(mocks.turnUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires an explicit idempotency key rather than using a legacy client message identifier", async () => {
    const request = { clientLastMessageId: "legacy-client-id" } as Parameters<
      typeof beginChatTurn
    >[3];
    await expect(
      beginChatTurn(
        "thread-1",
        [],
        { workspaceId: "workspace-1", userId: "user-1" },
        request,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.turnFindFirst).not.toHaveBeenCalled();
    expect(mocks.turnCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it.each([
    { status: "completed" },
    { status: "failed" },
    { status: "cancelled" },
    { status: "pending", startedAt: new Date() },
    { status: "pending", leaseToken: "claimed" },
    { status: "pending", stopRequestedAt: new Date() },
  ])(
    "replays a durable $status run without execution configuration",
    async (state) => {
      mocks.turnFindFirst.mockResolvedValueOnce({
        id: "existing",
        actorUserId: "user-1",
        requestHash: "hash",
        startedAt: null,
        leaseToken: null,
        stopRequestedAt: null,
        ...state,
        thread: { workspaceId: "workspace-1" },
      });
      await expect(
        getChatTurnReplay("user-1", "thread-1", "key", "hash"),
      ).resolves.toEqual({ runId: "existing", workspaceId: "workspace-1" });
      expect(mocks.turnFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            threadId: "thread-1",
            idempotencyKey: "key",
            thread: expect.objectContaining({
              workspace: expect.objectContaining({ status: "active" }),
            }),
          }),
          include: { thread: { select: { workspaceId: true } } },
        }),
      );
      expect(mocks.threadFindFirst).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.turnCreate).not.toHaveBeenCalled();
    },
  );

  it("lets normal admission claim an existing truly unclaimed pending run", async () => {
    mocks.turnFindFirst.mockResolvedValueOnce({
      id: "existing",
      status: "pending",
      actorUserId: "user-1",
      requestHash: "hash",
      startedAt: null,
      leaseToken: null,
      stopRequestedAt: null,
      thread: { workspaceId: "workspace-1" },
    });
    await expect(
      getChatTurnReplay("user-1", "thread-1", "key", "hash"),
    ).resolves.toBeNull();
    expect(mocks.turnCreate).not.toHaveBeenCalled();
  });

  it.each([
    { actorUserId: "other-user", requestHash: "hash", status: 403 },
    { actorUserId: "user-1", requestHash: "different-hash", status: 409 },
  ])(
    "rejects durable replay with actor/hash conflict $status",
    async ({ actorUserId, requestHash, status }) => {
      mocks.turnFindFirst.mockResolvedValueOnce({
        id: "existing",
        status: "completed",
        actorUserId,
        requestHash,
        thread: { workspaceId: "workspace-1" },
      });
      await expect(
        getChatTurnReplay("user-1", "thread-1", "key", "hash"),
      ).rejects.toMatchObject({ status });
      expect(mocks.turnCreate).not.toHaveBeenCalled();
    },
  );

  it("returns no replay for absent or inaccessible runs", async () => {
    await expect(
      getChatTurnReplay("user-1", "thread-1", "key", "hash"),
    ).resolves.toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("serializes pending turns without expiring durable work during admission", async () => {
    mocks.turnFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "running" });
    await expect(
      beginChatTurn(
        "thread-1",
        [],
        { workspaceId: "workspace-1", userId: "user-1" },
        { idempotencyKey: "new-request" },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.turnCreate).not.toHaveBeenCalled();
    expect(mocks.turnUpdateMany).not.toHaveBeenCalled();
  });

  it.each(["pending", "completed"])(
    "replays the same actor and hash before pending admission (%s)",
    async (status) => {
      mocks.turnFindFirst.mockResolvedValueOnce({
        id: "existing",
        status,
        actorUserId: "user-1",
        requestHash: "hash",
        messages: [{ id: "saved-assistant", parentId: "saved-user" }],
      });
      await expect(
        beginChatTurn(
          "thread-1",
          [],
          { workspaceId: "workspace-1", userId: "user-1" },
          { idempotencyKey: "key", requestHash: "hash" },
        ),
      ).resolves.toMatchObject({
        id: "existing",
        assistantMessageId: "saved-assistant",
        historyLeafId: "saved-user",
        replayed: true,
      });
      expect(mocks.turnFindFirst).toHaveBeenCalledTimes(1);
      expect(mocks.turnCreate).not.toHaveBeenCalled();
      expect(mocks.messageCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { actorUserId: "other", requestHash: "hash" },
    { actorUserId: "user-1", requestHash: "different" },
  ])("rejects reuse by a different actor or payload %j", async (existing) => {
    mocks.turnFindFirst.mockResolvedValueOnce({ ...existing, messages: [] });
    await expect(
      beginChatTurn(
        "thread-1",
        [],
        { workspaceId: "workspace-1", userId: "user-1" },
        { idempotencyKey: "key", requestHash: "hash" },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.turnCreate).not.toHaveBeenCalled();
  });

  it("keeps unresolved historical threads read-only", async () => {
    mocks.threadFindUnique.mockResolvedValue({
      workspaceId: "workspace-1",
      assistantRevisionId: null,
      legacyRevisionUnresolved: true,
    });
    await expect(
      beginChatTurn(
        "thread-1",
        [],
        { workspaceId: "workspace-1", userId: "user-1" },
        { idempotencyKey: "key" },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.turnCreate).not.toHaveBeenCalled();
  });

  it("maps the pending-turn unique constraint race to conflict", async () => {
    mocks.transaction.mockRejectedValue({ code: "P2002" });

    const promise = beginChatTurn(
      "thread-1",
      [{ type: "text", text: "Hello" }],
      { workspaceId: "workspace-1", userId: "user-1" },
      { idempotencyKey: "request-1" },
    );
    await expect(promise).rejects.toBeInstanceOf(ChatServiceError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      message: "A chat turn is already running",
    });
  });

  it("claims internal attachments in the same transaction as the user message", async () => {
    const parts = [{ type: "file", url: "/api/v1/attachments/attachment-1" }];

    await beginChatTurn(
      "thread-1",
      parts,
      {
        workspaceId: "workspace-1",
        userId: "user-1",
      },
      { idempotencyKey: "request-1" },
    );

    expect(mocks.attachmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "attachment-1",
          workspaceId: "workspace-1",
          uploadedById: "user-1",
        }),
        data: { chatThreadId: "thread-1" },
      }),
    );
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ parts }),
    });
  });

  it("ignores a temporary client message id for a new submit", async () => {
    mocks.threadFindUnique.mockResolvedValue({
      activeMessageId: "assistant-current",
      title: "Existing thread",
      workspaceId: "workspace-1",
      assistantRevisionId: "revision-1",
    });

    await beginChatTurn(
      "thread-1",
      [{ type: "text", text: "Next question" }],
      { workspaceId: "workspace-1", userId: "user-1" },
      {
        idempotencyKey: "request-1",
        trigger: "submit-message",
        clientLastMessageId: "client-temp-id",
      },
    );

    expect(mocks.messageFindFirst).toHaveBeenCalledWith({
      where: {
        id: "assistant-current",
        threadId: "thread-1",
        role: "user",
        parts: { equals: [] },
      },
      select: { id: true },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentId: "assistant-current",
        role: "user",
      }),
    });
  });

  it("fills an active reserved branch before creating its pending assistant", async () => {
    mocks.threadFindUnique.mockResolvedValue({
      activeMessageId: "reserved-user",
      title: "Existing thread",
      workspaceId: "workspace-1",
      assistantRevisionId: "revision-1",
    });
    mocks.messageFindFirst.mockResolvedValueOnce({ id: "reserved-user" });

    await beginChatTurn(
      "thread-1",
      [{ type: "text", text: "Continue this branch" }],
      { workspaceId: "workspace-1", userId: "user-1" },
      { idempotencyKey: "request-1" },
    );

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: "reserved-user" },
      data: {
        turnId: "turn-1",
        status: "success",
        parts: [{ type: "text", text: "Continue this branch" }],
      },
    });
    expect(mocks.messageCreate).toHaveBeenCalledOnce();
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentId: "reserved-user",
        role: "assistant",
        status: "pending",
      }),
    });
  });

  it("creates an explicit assistant sibling when regenerating a successful reply", async () => {
    mocks.messageFindFirst.mockResolvedValueOnce({
      id: "assistant-old",
      parentId: "user-1",
      siblingGroupId: null,
      turnId: "turn-old",
      role: "assistant",
      status: "success",
      parts: [{ type: "text", text: "Old answer" }],
    });

    const turn = await beginChatTurn(
      "thread-1",
      [],
      { workspaceId: "workspace-1", userId: "user-1" },
      {
        idempotencyKey: "request-1",
        trigger: "regenerate-message",
        messageId: "assistant-old",
        modelId: "model-old",
      },
    );

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: "assistant-old" },
      data: { siblingGroupId: "turn-1" },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentId: "user-1",
        siblingGroupId: "turn-1",
        role: "assistant",
        status: "pending",
        modelId: "model-old",
      }),
    });
    expect(turn.assistantMessageId).toBe("assistant-1");
  });

  it("regenerates a failed answer as a new run without overwriting history", async () => {
    mocks.messageFindFirst.mockResolvedValueOnce({
      id: "assistant-failed",
      parentId: "user-1",
      siblingGroupId: null,
      turnId: "turn-old",
      role: "assistant",
      status: "failed",
      parts: [],
    });

    const turn = await beginChatTurn(
      "thread-1",
      [],
      { workspaceId: "workspace-1", userId: "user-1" },
      {
        idempotencyKey: "request-1",
        trigger: "regenerate-message",
        messageId: "assistant-failed",
        modelId: "model-old",
      },
    );

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: "assistant-failed" },
      data: { siblingGroupId: "turn-1" },
    });
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        turnId: "turn-1",
        parentId: "user-1",
        role: "assistant",
        status: "pending",
      }),
    });
    expect(turn.assistantMessageId).toBe("assistant-1");
  });

  it("creates two selectable empty branches when branching from a leaf", async () => {
    mocks.threadFindUnique.mockResolvedValueOnce({
      id: "thread-1",
      activeMessageId: "assistant-leaf",
      turns: [],
    });
    mocks.messageFindFirst.mockResolvedValueOnce({
      id: "assistant-leaf",
      children: [],
    });
    mocks.messageCreate
      .mockResolvedValueOnce({ id: "empty-1" })
      .mockResolvedValueOnce({ id: "empty-2" });

    const branch = await reserveChatBranch(
      "user-1",
      "thread-1",
      "assistant-leaf",
    );

    expect(mocks.messageCreate).toHaveBeenCalledTimes(2);
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        parentId: "assistant-leaf",
        role: "user",
        parts: [],
      }),
    });
    expect(mocks.messageCreate.mock.calls[0]?.[0].data).not.toHaveProperty(
      "siblingGroupId",
    );
    expect(branch).toMatchObject({
      messages: [{ id: "empty-1" }, { id: "empty-2" }],
      activeMessageId: "empty-2",
      activated: true,
    });
  });

  it("commits a completed reply and its turn in one transaction", async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.messageUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      completeChatTurn("thread-1", "turn-1", "assistant-1", [
        { type: "text", text: "Done" },
      ]),
    ).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "assistant-1",
        threadId: "thread-1",
        turnId: "turn-1",
        role: "assistant",
        status: "pending",
      },
      data: { status: "success", parts: [{ type: "text", text: "Done" }] },
    });
  });

  it("persists a failed assistant placeholder with its turn", async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.messageUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(
      finishChatTurn(
        "thread-1",
        "turn-1",
        "failed",
        "provider failed",
        "assistant-1",
      ),
    ).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "assistant-1",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "pending",
      },
      data: { status: "failed" },
    });
  });

  it("does not resolve completion until its terminal event has persisted in the same transaction", async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
    let persistEvent: (() => void) | undefined;
    mocks.runEventCreate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          persistEvent = resolve;
        }),
    );
    let completed = false;
    const completion = completeChatTurn(
      "thread-1",
      "turn-1",
      "assistant-1",
      [{ type: "text", text: "Done" }],
      { leaseToken: "lease", generation: 3 },
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(mocks.runEventCreate).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.turnFindUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "turn-1" },
      select: {
        generation: true,
        lastEventSequence: true,
        stopRequestedAt: true,
      },
    });
    expect(mocks.runEventCreate).toHaveBeenCalledWith({
      data: {
        turnId: "turn-1",
        generation: 3,
        sequence: 8,
        payload: { type: "finish" },
      },
    });
    expect(mocks.turnUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.turnFindUniqueOrThrow.mock.invocationCallOrder[0],
    );
    expect(
      mocks.turnFindUniqueOrThrow.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.messageUpdateMany.mock.invocationCallOrder[0]);
    expect(mocks.messageUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runEventCreate.mock.invocationCallOrder[0],
    );
    if (!persistEvent)
      throw new Error("Terminal event persistence was not reached");
    persistEvent();
    await expect(completion).resolves.toBe(true);
  });

  it("settles a persisted stop as cancelled with partial output and one abort event", async () => {
    mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.turnFindUniqueOrThrow.mockResolvedValueOnce({
      generation: 3,
      lastEventSequence: 7,
      stopRequestedAt: new Date(),
    });
    const parts = [{ type: "text", text: "Partial" }];
    await expect(
      completeChatTurn("thread-1", "turn-1", "assistant-1", parts, {
        leaseToken: "lease",
        generation: 3,
      }),
    ).resolves.toBe(true);
    expect(mocks.turnUpdate).toHaveBeenCalledWith({
      where: { id: "turn-1" },
      data: { status: "cancelled" },
    });
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "cancelled", parts } }),
    );
    expect(mocks.runEventCreate).toHaveBeenCalledExactlyOnceWith({
      data: {
        turnId: "turn-1",
        generation: 3,
        sequence: 8,
        payload: { type: "abort" },
      },
    });
    expect(mocks.turnUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.messageUpdateMany.mock.invocationCallOrder[0],
    );
    expect(mocks.messageUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runEventCreate.mock.invocationCallOrder[0],
    );
  });

  it.each(["failed", "cancelled"] as const)(
    "publishes the %s terminal event after saving the assistant snapshot",
    async (status) => {
      mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
      const parts = [{ type: "text", text: "Partial" }];
      await expect(
        finishChatTurn(
          "thread-1",
          "turn-1",
          status,
          "provider failed",
          "assistant-1",
          parts,
          { leaseToken: "lease", generation: 3 },
        ),
      ).resolves.toBe(true);
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.runEventCreate).toHaveBeenCalledExactlyOnceWith({
        data: {
          turnId: "turn-1",
          generation: 3,
          sequence: 8,
          payload:
            status === "cancelled"
              ? { type: "abort" }
              : { type: "error", errorText: "provider failed" },
        },
      });
      expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status, parts } }),
      );
      expect(mocks.messageUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.runEventCreate.mock.invocationCallOrder[0],
      );
    },
  );

  it.each(["complete", "fail"])(
    "propagates terminal event insertion failure from the %s transaction",
    async (operation) => {
      mocks.turnUpdateMany.mockResolvedValueOnce({ count: 1 });
      const failure = new Error("Terminal event persistence failed");
      mocks.runEventCreate.mockRejectedValueOnce(failure);
      await expect(
        operation === "complete"
          ? completeChatTurn("thread-1", "turn-1", "assistant-1", [])
          : finishChatTurn(
              "thread-1",
              "turn-1",
              "failed",
              "provider failed",
              "assistant-1",
              [],
            ),
      ).rejects.toBe(failure);
      expect(mocks.transaction).toHaveBeenCalledOnce();
    },
  );

  it.each(["complete", "fail"])(
    "does not publish a terminal event when a stale %s fence loses",
    async (operation) => {
      mocks.turnUpdateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        operation === "complete"
          ? completeChatTurn("thread-1", "turn-1", "assistant-1", [], {
              leaseToken: "old",
              generation: 2,
            })
          : finishChatTurn(
              "thread-1",
              "turn-1",
              "failed",
              "old worker",
              "assistant-1",
              [],
              { leaseToken: "old", generation: 2 },
            ),
      ).resolves.toBe(false);
      expect(mocks.turnFindUniqueOrThrow).not.toHaveBeenCalled();
      expect(mocks.messageUpdateMany).not.toHaveBeenCalled();
      expect(mocks.runEventCreate).not.toHaveBeenCalled();
    },
  );

  it("does not hide unrelated database failures", async () => {
    const failure = new Error("database unavailable");
    mocks.transaction.mockRejectedValue(failure);

    await expect(
      beginChatTurn(
        "thread-1",
        [],
        {
          workspaceId: "workspace-1",
          userId: "user-1",
        },
        { idempotencyKey: "request-1" },
      ),
    ).rejects.toBe(failure);
  });

  it("scopes direct thread reads to both workspace and assistant", async () => {
    mocks.threadFindFirst.mockResolvedValue({
      activeMessageId: null,
      id: "thread-1",
      messages: [],
    });

    await getChatThreadForWorkspace("workspace-1", "assistant-1", "thread-1");

    expect(mocks.threadFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "thread-1",
          workspaceId: "workspace-1",
          assistantId: "assistant-1",
        },
      }),
    );
  });

  it("projects only the active branch for a direct thread read", async () => {
    const createdAt = new Date();
    mocks.threadFindFirst.mockResolvedValue({
      activeMessageId: "a-active",
      id: "thread-1",
      messages: [
        {
          id: "u-root",
          parentId: null,
          siblingGroupId: null,
          role: "user",
          status: "success",
          modelId: null,
          parts: [{ type: "text", text: "Hello" }],
          createdAt,
        },
        {
          id: "a-old",
          parentId: "u-root",
          siblingGroupId: "answers",
          role: "assistant",
          status: "success",
          modelId: "model-1",
          parts: [],
          createdAt,
        },
        {
          id: "a-active",
          parentId: "u-root",
          siblingGroupId: "answers",
          role: "assistant",
          status: "success",
          modelId: "model-1",
          parts: [],
          createdAt,
        },
      ],
    });

    const thread = await getChatThreadForWorkspace(
      "workspace-1",
      "assistant-1",
      "thread-1",
    );

    expect(thread?.messages.map((message) => message.id)).toEqual([
      "u-root",
      "a-active",
    ]);
    expect(thread?.branch.navigation).toEqual([
      expect.objectContaining({
        messageId: "a-active",
        position: 2,
        total: 2,
        previousMessageId: "a-old",
      }),
    ]);
  });

  it("switches a branch node to the latest leaf in its subtree", async () => {
    mocks.threadFindUnique.mockResolvedValue({
      id: "thread-1",
      messages: [
        { id: "u-root", parentId: null, siblingGroupId: null, role: "user" },
        {
          id: "a-old",
          parentId: "u-root",
          siblingGroupId: null,
          role: "assistant",
        },
        {
          id: "u-old",
          parentId: "a-old",
          siblingGroupId: "questions",
          role: "user",
        },
        {
          id: "a-old-leaf",
          parentId: "u-old",
          siblingGroupId: null,
          role: "assistant",
        },
        {
          id: "u-new",
          parentId: "a-old",
          siblingGroupId: "questions",
          role: "user",
        },
        {
          id: "a-new-leaf",
          parentId: "u-new",
          siblingGroupId: null,
          role: "assistant",
        },
      ],
    });

    await updateChatThread("user-1", "thread-1", { activeMessageId: "a-old" });

    expect(mocks.threadUpdate).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { activeMessageId: "a-new-leaf" },
    });
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
  });

  it("lists pinned assistants first without changing thread ordering", async () => {
    await listChatAssistantsForWorkspace("workspace-1");

    expect(mocks.assistantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-1" },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        include: expect.objectContaining({
          threads: expect.objectContaining({ orderBy: { updatedAt: "desc" } }),
        }),
      }),
    );
  });

  it("updates assistant configuration after workspace authorization", async () => {
    mocks.assistantFindFirst.mockResolvedValue({
      id: "assistant-1",
      workspaceId: "workspace-1",
      currentRevisionVersion: 1,
      mcpGrants: [],
      revisions: [],
    });

    await updateChatAssistant("user-1", "assistant-1", {
      expectedRevision: 1,
      pinned: true,
      description: "Finds primary sources.",
      modelParameters: { temperature: 0.4, topP: 0.8, maxOutputTokens: 2_000 },
    });

    expect(mocks.assistantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "assistant-1" },
        data: {
          pinned: true,
          description: "Finds primary sources.",
          modelParameters: {
            temperature: 0.4,
            topP: 0.8,
            maxOutputTokens: 2_000,
          },
        },
      }),
    );
  });

  it.each(["assistant-1", "assistant-2", "foreign"])(
    "never rebinds an existing thread to %s",
    async (assistantId) => {
      mocks.threadFindUnique.mockResolvedValue({
        id: "thread-1",
        assistantId: "assistant-1",
        workspaceId: "workspace-1",
        messages: [],
      });
      await expect(
        updateChatThread("user-1", "thread-1", {
          assistantId,
        } as unknown as Parameters<typeof updateChatThread>[2]),
      ).rejects.toMatchObject({ status: 400 });
      expect(mocks.threadUpdate).not.toHaveBeenCalled();
    },
  );

  it("rejects a turn when the thread moved after assistant resolution", async () => {
    mocks.threadFindUnique.mockResolvedValue({
      activeMessageId: null,
      assistantId: "assistant-2",
      title: null,
      workspaceId: "workspace-1",
      assistantRevisionId: "revision-1",
    });

    await expect(
      beginChatTurn(
        "thread-1",
        [{ type: "text", text: "Hello" }],
        { workspaceId: "workspace-1", userId: "user-1" },
        { idempotencyKey: "request-1", expectedAssistantId: "assistant-1" },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.turnCreate).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { id: "branch", role: "assistant", parts: [], children: [] },
    { id: "branch", role: "user", parts: {}, children: [] },
    {
      id: "branch",
      role: "user",
      parts: [{ type: "text", text: "Sent" }],
      children: [],
    },
    { id: "branch", role: "user", parts: [], children: [{ id: "response" }] },
  ])(
    "does not delete a consumed or invalid branch reservation %#",
    async (message) => {
      mocks.messageFindFirst.mockResolvedValue(message);
      await expect(
        deleteReservedChatBranch("user-1", "thread-1", "branch"),
      ).rejects.toMatchObject({
        status: 400,
        message: "Only an empty branch can be deleted",
      });
      expect(mocks.messageDelete).not.toHaveBeenCalled();
      expect(mocks.threadUpdate).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "deletes empty reservations without switching an unrelated active path (active=%s)",
    async (active) => {
      const thread = {
        id: "thread-1",
        activeMessageId: active ? "branch" : "other-branch",
      };
      const messages = [
        {
          id: "branch",
          parentId: "anchor",
          role: "user",
          parts: [],
          children: [],
        },
      ];
      mocks.threadFindUnique.mockResolvedValue(thread);
      mocks.messageFindFirst.mockResolvedValue(messages[0]);
      mocks.messageDelete.mockImplementation(async () => messages.pop());
      mocks.threadUpdate.mockImplementation(async ({ data }) =>
        Object.assign(thread, data),
      );
      expect(
        await deleteReservedChatBranch("user-1", "thread-1", "branch"),
      ).toEqual({ activeMessageId: active ? "anchor" : "other-branch" });
      expect(messages).toEqual([]);
      expect(thread.activeMessageId).toBe(active ? "anchor" : "other-branch");
    },
  );

  it.each(["authorization", "deleted-after-lock"])(
    "does not delete a branch after %s fails",
    async (failure) => {
      if (failure === "authorization")
        mocks.threadFindFirst.mockResolvedValue(null);
      else mocks.threadFindUnique.mockResolvedValue(null);
      await expect(
        deleteReservedChatBranch("user-1", "thread-1", "branch"),
      ).rejects.toMatchObject({ status: 404 });
      expect(mocks.messageDelete).not.toHaveBeenCalled();
    },
  );

  it.each([null, { activeMessageId: null, workspaceId: "other" }])(
    "does not create turn messages after locked workspace ownership changes %#",
    async (thread) => {
      mocks.threadFindUnique.mockResolvedValue(thread);
      await expect(
        beginChatTurn(
          "thread-1",
          [{ type: "text", text: "hello" }],
          {
            userId: "user-1",
            workspaceId: "workspace-1",
          },
          { idempotencyKey: "request-1" },
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(mocks.turnCreate).not.toHaveBeenCalled();
      expect(mocks.messageCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { id: "target", role: "system", parts: [] },
    { id: "target", role: "assistant", parentId: null, parts: [] },
  ])(
    "rejects regeneration of a missing or non-regenerable target %#",
    async (target) => {
      mocks.messageFindFirst.mockResolvedValue(target);
      await expect(
        beginChatTurn(
          "thread-1",
          [],
          { userId: "user-1", workspaceId: "workspace-1" },
          {
            idempotencyKey: "request-1",
            trigger: "regenerate-message",
            clientLastMessageId: "target",
          },
        ),
      ).rejects.toMatchObject({ status: target ? 400 : 404 });
      expect(mocks.messageCreate).not.toHaveBeenCalled();
    },
  );

  it.each([null, "existing-group"])(
    "regenerates a user message into its existing assistant sibling group (%s)",
    async (group) => {
      mocks.messageFindFirst.mockResolvedValue({
        id: "user-parent",
        role: "user",
        parts: [{ type: "text", text: "Question" }],
      });
      mocks.messageFindMany.mockResolvedValue([
        { id: "previous-answer", siblingGroupId: group },
      ]);
      const result = await beginChatTurn(
        "thread-1",
        [],
        { userId: "user-1", workspaceId: "workspace-1" },
        {
          idempotencyKey: "request-1",
          trigger: "regenerate-message",
          messageId: "user-parent",
        },
      );
      expect(result).toMatchObject({
        assistantParentId: "user-parent",
        historyLeafId: "user-parent",
      });
      expect(mocks.messageCreate).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          role: "assistant",
          parentId: "user-parent",
          siblingGroupId: group ?? "turn-1",
        }),
      });
      expect(mocks.messageUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { siblingGroupId: group ?? "turn-1" },
        }),
      );
    },
  );

  it("rejects execution history when the requested leaf does not belong to the authorized thread", async () => {
    mocks.threadFindFirst.mockResolvedValue({
      messages: [
        {
          id: "own-message",
          parentId: null,
          role: "user",
          parts: [],
          createdAt: new Date(),
        },
      ],
    });
    await expect(
      getChatHistoryForExecution("user-1", "thread-1", "foreign-message"),
    ).rejects.toMatchObject({ status: 404, message: "Chat message not found" });
  });

  it.each(["complete", "fail"])(
    "rejects stale assistant output while settling a %s turn",
    async (operation) => {
      mocks.turnUpdateMany.mockResolvedValue({ count: 1 });
      mocks.messageUpdateMany.mockResolvedValue({ count: 0 });
      await expect(
        operation === "complete"
          ? completeChatTurn("thread-1", "turn-1", "assistant-1", [])
          : finishChatTurn(
              "thread-1",
              "turn-1",
              "failed",
              "failure",
              "assistant-1",
            ),
      ).rejects.toMatchObject({
        status: 409,
        message: "Chat response is no longer pending",
      });
    },
  );
});
