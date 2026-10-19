// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  live: vi.fn(),
  context: vi.fn(),
  ready: vi.fn(),
  allocation: vi.fn(),
  update: vi.fn(),
  lease: vi.fn(),
  release: vi.fn(),
  run: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/a2a/principal", () => ({
  isLocalGrant: (grant: { kind?: string }) => grant.kind === "local",
  isRemoteGrant: (grant: { kind?: string }) => grant.kind === "remote",
  assertLiveGrant: mocks.live,
}));
vi.mock("@/lib/db", () => ({
  db: {
    a2AContext: { findFirstOrThrow: mocks.context },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: mocks.lock,
        agentEndpointRuntime: { findFirst: mocks.allocation },
        a2AContext: { update: mocks.update },
      }),
  },
}));
vi.mock("@/lib/agents/public-api/runtime", () => ({
  ensureAgentEndpointRuntime: mocks.ready,
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  acquireHermesRuntimeWriteLease: mocks.lease,
}));
vi.mock("@/lib/agents/hermes/client", () => ({
  runHermesTextStream: mocks.run,
}));
import { executePublishedTask } from "@/lib/a2a/executor";

const grant = {
  kind: "published",
  workspaceId: "workspace",
  ownerKey: "owner",
  endpointId: "endpoint",
  clientId: "client",
};
function row(): A2ATask {
  return {
    id: "task",
    contextId: "context",
    grant,
    deadlineAt: new Date(Date.now() + 60_000),
    snapshot: {
      id: "task",
      contextId: "context",
      status: { state: "TASK_STATE_WORKING" },
      history: [
        {
          messageId: "user",
          role: "ROLE_USER",
          parts: [{ text: "Review this" }, { data: { ignored: true } }],
        },
        {
          messageId: "agent",
          role: "ROLE_AGENT",
          parts: [{ text: "Working" }],
        },
      ],
    },
  } as unknown as A2ATask;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.live.mockResolvedValue(undefined);
  mocks.context.mockImplementation(async ({ where }) => {
    if (
      where.ownerKey !== "owner" ||
      where.endpointId !== "endpoint" ||
      where.clientId !== "client"
    )
      throw new Error("context not found");
    return {
      id: "context",
      endpointId: "endpoint",
      revisionId: "revision",
      clientId: "client",
      runtimeAllocationId: null,
    };
  });
  mocks.ready.mockResolvedValue({
    allocation: { id: "allocation" },
    agent: { id: "agent" },
  });
  mocks.allocation.mockResolvedValue({ id: "allocation" });
  mocks.lease.mockReturnValue({ release: mocks.release });
  mocks.run.mockResolvedValue("Reviewed");
});

describe("published task runtime ownership", () => {
  it("pins the context allocation before running and returns a completed text artifact", async () => {
    const result = await executePublishedTask(
      row(),
      new AbortController().signal,
    );
    expect(result.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(JSON.stringify(result.artifact)).toContain("Reviewed");
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "context" },
      data: { runtimeAllocationId: "allocation" },
    });
    expect(mocks.run.mock.calls[0][0].messages).toEqual([
      {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "Review this" }],
      },
      {
        id: "agent",
        role: "assistant",
        parts: [{ type: "text", text: "Working" }],
      },
    ]);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0],
    );
    expect(mocks.live).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each(["local", "remote"])(
    "rejects %s targets before acquiring runtime access",
    async (kind) => {
      await expect(
        executePublishedTask(
          { ...row(), grant: { ...grant, kind } },
          new AbortController().signal,
        ),
      ).rejects.toThrow("published target");
      expect(mocks.ready).not.toHaveBeenCalled();
    },
  );

  it.each(["ownerKey", "endpointId", "clientId"])(
    "does not cross the %s context boundary",
    async (key) => {
      await expect(
        executePublishedTask(
          { ...row(), grant: { ...grant, [key]: "other" } },
          new AbortController().signal,
        ),
      ).rejects.toThrow("context not found");
      expect(mocks.ready).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );

  it.each(["endpointId", "revisionId", "clientId"])(
    "rejects contexts missing %s",
    async (key) => {
      mocks.context.mockResolvedValue({
        id: "context",
        endpointId: "endpoint",
        revisionId: "revision",
        clientId: "client",
        [key]: null,
      });
      await expect(
        executePublishedTask(row(), new AbortController().signal),
      ).rejects.toThrow("Invalid published context");
      expect(mocks.ready).not.toHaveBeenCalled();
    },
  );

  it("rejects allocations removed while waiting for the transaction lock", async () => {
    mocks.allocation.mockResolvedValue(null);
    await expect(
      executePublishedTask(row(), new AbortController().signal),
    ).rejects.toThrow("runtime allocation changed");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.lease).not.toHaveBeenCalled();
  });

  it("never rebinds an existing context to another allocation", async () => {
    mocks.context.mockResolvedValue({
      id: "context",
      endpointId: "endpoint",
      revisionId: "revision",
      clientId: "client",
      runtimeAllocationId: "old-allocation",
    });
    await expect(
      executePublishedTask(row(), new AbortController().signal),
    ).rejects.toThrow("context runtime changed");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("does not execute when the runtime write lease is busy", async () => {
    mocks.lease.mockReturnValue(null);
    await expect(
      executePublishedTask(row(), new AbortController().signal),
    ).rejects.toThrow("runtime is busy");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["runtime", "revoked", "aborted"])(
    "releases ownership without publishing a result after %s failure",
    async (failure) => {
      const controller = new AbortController();
      if (failure === "runtime")
        mocks.run.mockRejectedValue(new Error("runtime failed"));
      if (failure === "revoked")
        mocks.live
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("revoked"));
      if (failure === "aborted")
        mocks.run.mockImplementation(async () => {
          controller.abort(new Error("cancelled"));
          return "late output";
        });
      await expect(
        executePublishedTask(row(), controller.signal),
      ).rejects.toThrow();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );

  it("honors cancellation before provisioning and after provisioning", async () => {
    const early = new AbortController();
    early.abort();
    await expect(executePublishedTask(row(), early.signal)).rejects.toThrow();
    expect(mocks.ready).not.toHaveBeenCalled();
    const late = new AbortController();
    mocks.ready.mockImplementation(async () => {
      late.abort();
      return { allocation: { id: "allocation" }, agent: { id: "agent" } };
    });
    await expect(executePublishedTask(row(), late.signal)).rejects.toThrow();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
