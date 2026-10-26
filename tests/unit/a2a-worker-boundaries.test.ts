// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import { assertDefined } from "../assert-defined";
const state = vi.hoisted(() => ({
  rows: new Map<string, A2ATask>(),
  owner: true,
  closing: false,
  messages: new Map<string, string>(),
  release: vi.fn(),
  claim: vi.fn(),
  interrupt: vi.fn(),
  finish: vi.fn(),
  releaseClaim: vi.fn(),
  find: vi.fn(),
  assigned: vi.fn(),
  live: vi.fn(),
  target: vi.fn(),
  localWaits: vi.fn(),
  remoteWaits: vi.fn(),
  log: vi.fn(),
  execute: vi.fn(),
  admit: vi.fn(),
}));
vi.mock("@/lib/agents/agent-execution-gate", () => ({
  AgentExecutionBusyError: class AgentExecutionBusyError extends Error {},
  withAgentExecutionLease: state.admit,
}));
vi.mock("@/lib/a2a/local-sandbox", () => ({
  localTaskSandbox: () => state.target(),
}));
vi.mock("@/lib/agents/conversation-sandbox", () => ({
  deleteAgentContextSandbox: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    a2ATask: {
      findUnique: vi.fn(async ({ where }) => state.rows.get(where.id) ?? null),
      findMany: state.find,
      updateMany: vi.fn(async ({ where, data }) => {
        const row = state.rows.get(where.id);
        if (!row || row.leaseToken !== where.leaseToken) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.rows.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    agentSandbox: { findMany: state.assigned },
    a2AContext: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/a2a/store", () => ({
  claimTask: state.claim,
  finishTask: state.finish,
  interruptTask: state.interrupt,
  releasePiHarnessClaim: state.releaseClaim,
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  assertRuntimeOwner: () => {
    if (!state.owner) throw new Error("not owner");
  },
  runtimeCanOperate: () => state.owner,
  runtimeAbortSignal: () => undefined,
  trackRuntimeOperation: (run: () => Promise<unknown>) => run(),
}));
vi.mock("@/lib/workspace/operation-gate", () => ({
  beginWorkspaceOperation: () => (state.closing ? null : state.release),
}));
vi.mock("@/lib/a2a/principal", () => ({
  assertLiveGrant: state.live,
  isLocalGrant: (grant: { kind?: string }) => grant.kind === "local",
  isRemoteGrant: (grant: { kind?: string }) => grant.kind === "remote",
  isWorkspaceGrant: (grant: { kind?: string }) =>
    grant.kind === "local" || grant.kind === "published",
}));
vi.mock("@/lib/a2a/local-policy", () => ({ localTarget: state.target }));
vi.mock("@/lib/a2a/local-continuation", () => ({
  reconcileLocalWaits: state.localWaits,
}));
vi.mock("@/lib/a2a/remote-executor", () => ({
  reconcileRemoteTasks: state.remoteWaits,
}));
vi.mock("@/lib/a2a/executor", () => ({ executeTask: state.execute }));
vi.mock("@/lib/agents/pi-harness", () => ({
  PiRuntimeInterruptedError: class PiRuntimeInterruptedError extends Error {},
}));
vi.mock("@/lib/observability/system", () => ({ systemLog: state.log }));
vi.mock("@/lib/observability/a2a-log", () => ({
  recordA2AEvent: vi.fn(),
  taskStateName: (name: string) => name,
}));
import { db } from "@/lib/db";
import { A2AQuotaError } from "@/lib/a2a/quotas";
import { A2A_LIMITS } from "@/lib/a2a/model";
import { PiRuntimeInterruptedError } from "@/lib/agents/pi-harness";
import { AgentExecutionBusyError } from "@/lib/agents/agent-execution-gate";
import {
  executeA2ATask,
  startA2AWorker,
  stopA2AWorker,
  tickA2AWorker,
  wakeA2AWorker,
} from "@/lib/a2a/worker";
import { withSandboxExecutionLease } from "@/lib/agents/sandbox-execution-gate";

function task(kind = "local", backend = "legacy", bound = false) {
  const row = {
    id: "task",
    contextId: "context",
    state: TaskState.TASK_STATE_SUBMITTED,
    phase: "queued",
    executionBackend: backend,
    nativeOperationId: bound ? "operation" : null,
    leaseToken: "lease",
    deadlineAt: new Date(Date.now() + 60_000),
    grant: {
      kind,
      workspaceId: "workspace",
      agentId: "agent",
      ownerKey: "owner",
      ancestorTaskIds: [],
      entryPolicy: "delegation",
    },
  } as unknown as A2ATask;
  state.rows.set(row.id, row);
  return row;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  state.admit.mockImplementation((_input, run) => run());
  state.rows.clear();
  state.messages.clear();
  state.owner = true;
  state.closing = false;
  state.find.mockResolvedValue([]);
  state.assigned.mockResolvedValue([{ sandboxId: "sandbox" }]);
  state.target.mockResolvedValue({ sandboxId: "sandbox" });
  state.remoteWaits.mockResolvedValue(undefined);
  state.localWaits.mockResolvedValue(undefined);
  state.claim.mockImplementation(async (id) => state.rows.get(id) ?? null);
  state.finish.mockImplementation(async (id, leaseToken, terminal, message) => {
    const row = state.rows.get(id);
    if (row?.leaseToken === leaseToken) {
      Object.assign(assertDefined(row), { state: terminal, leaseToken: null });
      state.messages.set(id, message);
    }
  });
  state.interrupt.mockImplementation(async (id, message) => {
    const row = state.rows.get(id);
    if (row) {
      Object.assign(row, { state: TaskState.TASK_STATE_FAILED });
      state.messages.set(id, message);
    }
  });
  state.releaseClaim.mockImplementation(async (id, leaseToken) => {
    const row = state.rows.get(id);
    if (row?.leaseToken === leaseToken)
      Object.assign(assertDefined(row), {
        leaseToken: null,
        phase: "resumable",
      });
  });
  await startA2AWorker();
  vi.clearAllTimers();
});
afterEach(() => {
  stopA2AWorker();
  vi.useRealTimers();
});

describe("A2A worker admission and recovery boundaries", () => {
  it("keeps public and remote work pooled without capping local sandboxes", async () => {
    const released = Promise.withResolvers<void>();
    const running: Promise<void>[] = [];
    function row(id: string, kind: string) {
      const value = task(kind);
      state.rows.delete(value.id);
      value.id = id;
      state.rows.set(id, value);
      return value;
    }
    try {
      for (let index = 0; index < A2A_LIMITS.workerConcurrency; index++) {
        const held = row(`pooled-${index}`, index % 2 ? "remote" : "published");
        const entered = Promise.withResolvers<void>();
        const execution = executeA2ATask(held.id, async () => {
          entered.resolve();
          await released.promise;
          return { state: TaskState.TASK_STATE_COMPLETED };
        });
        running.push(execution);
        await Promise.race([
          entered.promise,
          execution.then(() => {
            throw new Error("Expected available pooled capacity");
          }),
        ]);
      }
      const queued = row("pooled-waiting", "published");
      const result = { state: TaskState.TASK_STATE_COMPLETED };
      await executeA2ATask(queued.id, async () => result);
      expect(queued.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      const local = row("local-running", "local");
      await executeA2ATask(local.id, async () => result);
      expect(local.state).toBe(TaskState.TASK_STATE_COMPLETED);
      released.resolve();
      await Promise.all(running);
      await executeA2ATask(queued.id, async () => result);
      expect(queued.state).toBe(TaskState.TASK_STATE_COMPLETED);
    } finally {
      released.resolve();
      await Promise.all(running);
    }
  });
  it.each([false, true])(
    "keeps full-capacity roots queued and rejects children (child=%s)",
    async (child) => {
      const row = task();
      row.grant = {
        ...(row.grant as object),
        ancestorTaskIds: child ? ["parent"] : [],
      };
      state.admit.mockRejectedValue(new AgentExecutionBusyError());
      await executeA2ATask(row.id);
      expect(row.state).toBe(
        child ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_SUBMITTED,
      );
      expect(state.claim).not.toHaveBeenCalled();
      expect(state.target).not.toHaveBeenCalled();
    },
  );
  it("does not execute duplicate concurrent claims or operate after owner loss", async () => {
    task();
    const ready = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const executor = vi.fn(async () => {
      ready.resolve();
      await done.promise;
      return { state: TaskState.TASK_STATE_COMPLETED };
    });
    const first = executeA2ATask("task", executor);
    await ready.promise;
    await executeA2ATask("task", executor);
    expect(executor).toHaveBeenCalledOnce();
    done.resolve();
    await first;
    state.owner = false;
    await executeA2ATask("task", executor);
    expect(executor).toHaveBeenCalledOnce();
  });

  it.each(["legacy", "pi-harness"])(
    "quota exhaustion does not replay a %s operation",
    async (backend) => {
      const row = task("local", backend, backend === "pi-harness");
      state.claim.mockRejectedValue(new A2AQuotaError());
      if (backend === "pi-harness")
        await expect(executeA2ATask(row.id)).rejects.toBeInstanceOf(
          A2AQuotaError,
        );
      else {
        await executeA2ATask(row.id);
        expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
      }
      expect(state.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["remote", "published"])(
    "settles unavailable execution for a %s target without disclosing errors",
    async (kind) => {
      const row = task(kind);
      await executeA2ATask(row.id, async () => {
        throw new Error("credential=secret");
      });
      expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(state.messages.get(row.id)).not.toContain("secret");
      expect(
        kind === "remote" ? state.interrupt : state.finish,
      ).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "allows deferred observations only for remote targets (remote=%s)",
    async (remote) => {
      const row = task(remote ? "remote" : "local");
      await executeA2ATask(row.id, async () => ({
        state: TaskState.TASK_STATE_WORKING,
        deferred: true,
      }));
      expect(row.state).toBe(
        remote ? TaskState.TASK_STATE_SUBMITTED : TaskState.TASK_STATE_FAILED,
      );
      expect(state.release).toHaveBeenCalledOnce();
    },
  );

  it.each([TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_CANCELED])(
    "rejects invalid legacy terminal state %s",
    async (terminal) => {
      const row = task();
      await executeA2ATask(row.id, async () => ({ state: terminal }));
      expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
    },
  );

  it.each([
    "PI_SESSION_MISSING: secret prompt",
    "PI_MODEL_UNAVAILABLE",
    "unexpected secret",
    17,
  ])("sanitizes native failure %# to fixed error codes", async (message) => {
    const row = task("local", "pi-harness", true);
    await executeA2ATask(row.id, async () => {
      throw typeof message === "string" ? new Error(message) : message;
    });
    expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(state.messages.get(row.id)).toMatch(
      /^(PI_SESSION_MISSING|PI_MODEL_UNAVAILABLE|PI_EXECUTION_FAILED):/,
    );
    expect(state.messages.get(row.id)).not.toContain("secret");
    expect(state.finish.mock.calls[0][5]).toEqual({
      nativeOperationId: "operation",
    });
  });

  it.each([
    [new A2AQuotaError(), "PI_STORAGE_QUOTA_EXCEEDED"],
    [
      new Error("PI_OUTPUT_TRUNCATED: model stopped at its output limit"),
      "PI_OUTPUT_TRUNCATED",
    ],
  ])(
    "preserves the %s storage or truncation cause for the caller",
    async (error, code) => {
      const row = task("local", "pi-harness", true);
      await executeA2ATask(row.id, async () => {
        throw error;
      });
      expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(state.messages.get(row.id)).toMatch(new RegExp(`^${code}:`));
    },
  );

  it("releases an interrupted native claim for recovery without recording task failure", async () => {
    const row = task("local", "pi-harness", true);
    await executeA2ATask(row.id, async () => {
      throw new PiRuntimeInterruptedError("owner lost");
    });
    expect(row).toMatchObject({
      phase: "resumable",
      leaseToken: null,
      state: TaskState.TASK_STATE_SUBMITTED,
    });
    expect(state.finish).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "recovers a bound operation when sandbox assignment changes (bound=%s)",
    async (bound) => {
      const row = task("local", "pi-harness", bound);
      state.assigned.mockResolvedValue([]);
      state.target.mockRejectedValue(new Error("private provider error"));
      if (bound) {
        await expect(executeA2ATask(row.id)).rejects.toBeInstanceOf(
          PiRuntimeInterruptedError,
        );
        expect(row.state).toBe(TaskState.TASK_STATE_SUBMITTED);
        expect(state.finish).not.toHaveBeenCalled();
        expect(state.claim).not.toHaveBeenCalled();
      } else {
        await executeA2ATask(row.id);
        expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
        expect(state.messages.get(row.id)).toMatch(/^PI_TARGET_UNAVAILABLE:/);
      }
      expect(state.execute).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "queues busy roots but fails busy child work promptly (child=%s)",
    async (child) => {
      const row = task();
      if (child)
        row.grant = {
          kind: "local",
          workspaceId: "workspace",
          agentId: "agent",
          ancestorTaskIds: ["parent"],
        };
      await withSandboxExecutionLease("sandbox", () => executeA2ATask(row.id));
      expect(row.state).toBe(
        child ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_SUBMITTED,
      );
      expect(state.execute).not.toHaveBeenCalled();
      expect(state.claim).not.toHaveBeenCalled();
    },
  );

  it("aborts legacy work when its claim changes and clears watchdogs", async () => {
    const row = task();
    const ready = Promise.withResolvers<void>();
    const executor = vi.fn(async (_row, signal: AbortSignal) => {
      ready.resolve();
      const stopped = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => stopped.resolve(), { once: true });
      await stopped.promise;
      signal.throwIfAborted();
      return { state: TaskState.TASK_STATE_COMPLETED };
    });
    const operation = executeA2ATask(row.id, executor);
    await ready.promise;
    state.rows.delete(row.id);
    await vi.advanceTimersByTimeAsync(1_000);
    await operation;
    expect(state.finish).toHaveBeenCalledWith(
      "task",
      "lease",
      TaskState.TASK_STATE_FAILED,
      expect.stringContaining("No automatic replay"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires unstarted tasks, isolates remote observation failures and prunes only inactive contexts", async () => {
    const row = task();
    state.find.mockResolvedValueOnce([{ id: row.id }]).mockResolvedValue([]);
    state.remoteWaits.mockRejectedValue(new Error("private network error"));
    vi.mocked(db.a2AContext.findMany).mockResolvedValueOnce([
      { id: "expired-context" },
    ] as never);
    await tickA2AWorker();
    expect(row.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(state.messages.get(row.id)).toBe("Task deadline exceeded.");
    expect(state.log).toHaveBeenCalledWith(
      "error",
      "Remote A2A observation failed.",
    );
    expect(db.a2AContext.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["expired-context"] } }),
      }),
    );
    const calls = vi.mocked(db.a2AContext.findMany).mock.calls.length;
    await tickA2AWorker();
    expect(db.a2AContext.findMany).toHaveBeenCalledTimes(calls);
  });

  it("logs wake admission errors without leaking task content", async () => {
    state.localWaits.mockRejectedValue(new Error("private task"));
    wakeA2AWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.log).toHaveBeenCalledWith(
      "error",
      "A2A admission wake failed.",
    );
  });
});
