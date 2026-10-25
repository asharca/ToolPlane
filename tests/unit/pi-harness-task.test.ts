// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";

const calls = vi.hoisted(() => ({
  cancel: vi.fn(),
  context: vi.fn(),
  sandbox: vi.fn(),
  owner: true,
  ownerSignal: undefined as AbortSignal | undefined,
}));
vi.mock("@/lib/a2a/principal", () => ({
  isLocalGrant: (grant: { kind: string }) => grant.kind === "local",
}));
vi.mock("@/lib/db", () => ({
  db: { a2AContext: { findFirst: calls.context } },
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: vi.fn(),
  runtimeCanOperate: () => calls.owner,
  runtimeAbortSignal: () => calls.ownerSignal,
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  findAgentConversationSandbox: calls.sandbox,
}));
vi.mock("@/lib/agents/sandbox-runtime", () => ({
  cancelPiHarnessOperation: calls.cancel,
}));
import {
  drainRetiredPiHarnessTask,
  PiRuntimeInterruptedError,
} from "@/lib/agents/pi-harness";

const row = {
  id: "task",
  contextId: "context",
  executionBackend: "pi-harness",
  nativeOperationId: "bound-operation",
  leaseToken: "lease",
  grant: {
    kind: "local",
    workspaceId: "workspace",
    agentId: "agent",
    ownerKey: "owner",
  },
} as unknown as A2ATask;

beforeEach(() => {
  vi.resetAllMocks();
  calls.owner = true;
  calls.ownerSignal = undefined;
  calls.context.mockResolvedValue({ id: "context" });
  calls.sandbox.mockResolvedValue({ sandboxId: "retained-volume" });
  calls.cancel.mockResolvedValue({
    status: "aborted",
    text: "Processes drained; previous effects remain unknown.",
  });
});

it("drains only the durable bound operation without model credentials or runtime preparation", async () => {
  const signal = AbortSignal.abort(new Error("caller canceled"));
  const result = await drainRetiredPiHarnessTask(row, signal);
  expect(calls.context).toHaveBeenCalledWith({
    where: {
      id: "context",
      workspaceId: "workspace",
      agentId: "agent",
      targetKind: "local",
      ownerKey: "owner",
    },
  });
  expect(calls.sandbox).toHaveBeenCalledWith({
    workspaceId: "workspace",
    agentId: "agent",
    contextId: "context",
    cleanup: true,
  });
  expect(calls.cancel).toHaveBeenCalledTimes(1);
  expect(calls.cancel).toHaveBeenCalledWith(
    {
      workspaceId: "workspace",
      agentId: "agent",
      sandboxId: "retained-volume",
      a2aContextId: "context",
    },
    { taskId: "task", contextId: "context", operationId: "bound-operation" },
  );
  expect(result).toMatchObject({
    state: TaskState.TASK_STATE_CANCELED,
    nativeOperationId: "bound-operation",
    message: "Processes drained; previous effects remain unknown.",
  });
});

it.each([
  { executionBackend: "pi-sdk" },
  { nativeOperationId: null },
  { leaseToken: null },
  { grant: { kind: "remote" } },
])(
  "never creates or resumes retired execution for an unbound task: %j",
  async (change) => {
    await expect(
      drainRetiredPiHarnessTask(
        { ...row, ...change } as A2ATask,
        new AbortController().signal,
      ),
    ).rejects.toThrow("already-bound operation");
    expect(calls.context).not.toHaveBeenCalled();
    expect(calls.cancel).not.toHaveBeenCalled();
  },
);

it("rejects a missing owned context before touching a historical workspace", async () => {
  calls.context.mockResolvedValue(null);
  await expect(
    drainRetiredPiHarnessTask(row, new AbortController().signal),
  ).rejects.toThrow("context is unavailable");
  expect(calls.sandbox).not.toHaveBeenCalled();
  expect(calls.cancel).not.toHaveBeenCalled();
});

it("retains unavailable historical volumes without replacing or replaying them", async () => {
  calls.sandbox.mockResolvedValue(null);
  await expect(
    drainRetiredPiHarnessTask(row, new AbortController().signal),
  ).rejects.toBeInstanceOf(PiRuntimeInterruptedError);
  expect(calls.cancel).not.toHaveBeenCalled();
});

it("propagates an unconfirmed process stop rather than reporting cancellation", async () => {
  const error = new Error("PI_PROCESS_STOP_UNCONFIRMED");
  calls.cancel.mockRejectedValue(error);
  await expect(
    drainRetiredPiHarnessTask(row, new AbortController().signal),
  ).rejects.toBe(error);
});

it("classifies ownership loss during drain as interruption, not confirmed cancellation", async () => {
  calls.cancel.mockImplementation(async () => {
    calls.owner = false;
    throw new Error("owner lost");
  });
  await expect(
    drainRetiredPiHarnessTask(row, new AbortController().signal),
  ).rejects.toBeInstanceOf(PiRuntimeInterruptedError);
});
