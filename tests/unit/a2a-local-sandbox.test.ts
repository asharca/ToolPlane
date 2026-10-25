// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type { A2ATask } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  live: vi.fn(),
  owner: vi.fn(),
  ensure: vi.fn(),
  find: vi.fn(),
  work: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/a2a/principal", () => ({
  isLocalGrant: (grant: { kind?: string }) => grant.kind === "local",
  assertLiveGrant: mocks.live,
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: mocks.owner,
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  ensureAgentConversationSandbox: mocks.ensure,
  findAgentConversationSandbox: mocks.find,
}));
vi.mock("@/lib/db", () => ({
  db: { workSession: { findFirst: mocks.work, updateMany: mocks.update } },
}));
import { localTaskSandbox } from "@/lib/a2a/local-sandbox";

const task = (kind = "chat", child = false) =>
  ({
    contextId: "context",
    executionBackend: "pi-sdk",
    nativeOperationId: null,
    grant: {
      kind: "local",
      workspaceId: "workspace",
      agentRevisionId: "revision",
      agentId: "agent",
      ancestorTaskIds: child ? ["parent"] : [],
      entryPolicy: { kind, sourceId: "source" },
    },
  }) as unknown as A2ATask;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ensure.mockResolvedValue({
    sandboxId: "isolated",
    deploymentId: "deployment",
  });
  mocks.find.mockResolvedValue({
    sandboxId: "bound",
    deploymentId: "bound-deployment",
  });
});

it.each(["chat", "control", "channel"])(
  "binds validated %s entry conversation and exact native context",
  async (kind) => {
    await expect(localTaskSandbox(task(kind))).resolves.toMatchObject({
      conversationId: "source",
      a2aContextId: "context",
      sandboxId: "isolated",
    });
    expect(mocks.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace",
        agentId: "agent",
        conversationId: "source",
        contextId: "context",
      }),
    );
  },
);
it("resolves Work conversation server-side and persists its selected sandbox", async () => {
  mocks.work.mockResolvedValue({ conversationId: "work-conversation" });
  await localTaskSandbox(task("work"));
  expect(mocks.ensure).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: "work-conversation" }),
  );
  expect(mocks.update).toHaveBeenCalledWith({
    where: {
      id: "source",
      workspaceId: "workspace",
      agentId: "agent",
      conversationId: "work-conversation",
    },
    data: { sandboxId: "isolated" },
  });
});
it("does not bind a delegated target to the parent's conversation", async () => {
  await localTaskSandbox(task("chat", true));
  expect(mocks.ensure).toHaveBeenCalledWith(
    expect.objectContaining({
      conversationId: undefined,
      contextId: "context",
    }),
  );
});
it("denies revoked authorization before allocating, without template fallback", async () => {
  mocks.live.mockRejectedValue(new Error("revoked"));
  await expect(localTaskSandbox(task())).rejects.toThrow("revoked");
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.find).not.toHaveBeenCalled();
});
it("permits owner-only cleanup of an already-bound operation without regranting execution", async () => {
  mocks.live.mockRejectedValue(new Error("revoked"));
  await expect(
    localTaskSandbox(
      {
        ...task(),
        executionBackend: "pi-harness",
        nativeOperationId: "operation",
      },
      true,
    ),
  ).resolves.toMatchObject({
    sandboxId: "bound",
  });
  expect(mocks.owner).toHaveBeenCalled();
  expect(mocks.live).not.toHaveBeenCalled();
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.find).toHaveBeenCalledWith(
    expect.objectContaining({ cleanup: true, contextId: "context" }),
  );
});
it("denies cleanup without ownership or bound operation", async () => {
  await expect(
    localTaskSandbox({ ...task(), nativeOperationId: null }, true),
  ).rejects.toThrow("bound operation");
  mocks.owner.mockImplementation(() => {
    throw new Error("not owner");
  });
  await expect(
    localTaskSandbox(
      {
        ...task(),
        executionBackend: "pi-harness",
        nativeOperationId: "operation",
      },
      true,
    ),
  ).rejects.toThrow("not owner");
  expect(mocks.find).not.toHaveBeenCalled();
});
