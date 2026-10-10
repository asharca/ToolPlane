import "server-only";
import { A2AQuotaError } from "./quotas";
import { TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import { db } from "@/lib/db";
import {
  assertRuntimeOwner,
  runtimeAbortSignal,
  runtimeCanOperate,
  trackRuntimeOperation,
} from "@/lib/runtime/ownership-state";
import { beginWorkspaceOperation } from "@/lib/workspace/operation-gate";
import { withLogContext } from "@/lib/observability/context";
import { recordA2AEvent, taskStateName } from "@/lib/observability/a2a-log";
import { systemLog } from "@/lib/observability/system";
import { ACTIVE, A2A_LIMITS } from "./model";
import {
  claimTask,
  finishTask,
  interruptTask,
  releasePiHarnessClaim,
} from "./store";
import {
  assertLiveGrant,
  isLocalGrant,
  isRemoteGrant,
  type TaskGrant,
} from "./principal";
import {
  sandboxExecutionBusy,
  withSandboxExecutionLease,
  SandboxExecutionBusyError,
} from "@/lib/agents/sandbox-execution-gate";
import { PiRuntimeInterruptedError } from "@/lib/agents/pi-harness";
import { localTarget } from "./local-policy";
import { reconcileLocalWaits } from "./local-continuation";
import { reconcileRemoteTasks } from "./remote-executor";
import { executeTask, type TaskExecutor } from "./executor";

type ActiveExecution = {
  controller: AbortController;
  native: boolean;
  running: boolean;
};
type State = {
  active: Map<string, ActiveExecution>;
  ticking: boolean;
  stopped: boolean;
  timer?: NodeJS.Timeout;
  prunedAt: number;
};
const globalState = globalThis as typeof globalThis & {
  __nativeA2AWorker?: State;
};
const state: State = globalState.__nativeA2AWorker ?? {
  active: new Map(),
  ticking: false,
  stopped: false,
  prunedAt: 0,
};
globalState.__nativeA2AWorker = state;
function nativeFailure(error: unknown) {
  if (error instanceof SandboxExecutionBusyError)
    return "PI_SANDBOX_BUSY: The target sandbox is busy; the child task was not started.";
  // Only fixed codes may escape: native exception text can contain credentials or task content.
  const code =
    error instanceof Error
      ? /^(PI_SESSION_MISSING|PI_SESSION_CORRUPT|PI_MODEL_UNAVAILABLE|PI_INPUT_INVALID|PI_CONFIG_INVALID|PI_PROCESS_STOP_UNCONFIRMED|PI_NODE_UNSUPPORTED|PI_SQLITE_UNAVAILABLE|PI_HARNESS_VERSION_MISMATCH|PI_RECOVERY_CHECK_FAILED|PI_PROTOCOL_ERROR|PI_TARGET_UNAVAILABLE)(?=:|$)/.exec(
          error.message,
        )?.[1]
      : undefined;
  return `${code ?? "PI_EXECUTION_FAILED"}: Pi task execution failed. No automatic replay was performed.`;
}
export function executeA2ATask(
  id: string,
  executor: TaskExecutor = executeTask,
) {
  if (state.stopped || !runtimeCanOperate() || state.active.has(id))
    return Promise.resolve();
  const controller = new AbortController();
  const active: ActiveExecution = { controller, native: false, running: false };
  state.active.set(id, active);
  const operation = async (unavailable?: Error) => {
    let claimed: A2ATask | null;
    try {
      if (state.stopped || !runtimeCanOperate()) return;
      claimed = await claimTask(id);
      if (!claimed) return;
    } catch (error) {
      if (
        active.native &&
        (error instanceof PiRuntimeInterruptedError ||
          controller.signal.reason instanceof PiRuntimeInterruptedError ||
          runtimeAbortSignal()?.aborted ||
          !runtimeCanOperate())
      )
        return;
      if (error instanceof A2AQuotaError) {
        const current = await db.a2ATask.findUnique({
          where: { id },
          select: { executionBackend: true, nativeOperationId: true },
        });
        if (
          current?.executionBackend === "pi-harness" &&
          current.nativeOperationId
        )
          throw error;
        await interruptTask(
          id,
          "Execution was not started because the Agent resource quota was exhausted.",
        );
        return;
      }
      throw error;
    }
    const row = claimed;
    const grant = row.grant as unknown as TaskGrant;
    return withLogContext(
      {
        workspaceId: grant.workspaceId,
        suppressPayload: true,
        ...(isLocalGrant(grant)
          ? { actorId: grant.actorId, agentId: grant.agentId }
          : isRemoteGrant(grant)
            ? { actorId: grant.actorId, agentId: grant.sourceAgentId }
            : {}),
      },
      async () => {
        let release: (() => void) | null = null;
        let timeout: NodeJS.Timeout | undefined;
        let watchdog: NodeJS.Timeout | undefined;
        let checking = false;
        try {
          await recordA2AEvent({
            eventName: "a2a.task.started",
            binding: {
              grant,
              taskId: row.id,
              contextId: row.contextId,
              rootTaskId: row.rootTaskId ?? row.id,
              parentTaskId: row.parentTaskId ?? undefined,
            },
            metadata: {
              direction: "internal",
              transport: "entry",
              taskState: taskStateName(TaskState[row.state]),
            },
            outcome: "success",
          });
          if (
            active.native &&
            (controller.signal.reason instanceof PiRuntimeInterruptedError ||
              !runtimeCanOperate())
          )
            throw new PiRuntimeInterruptedError();
          if (unavailable) throw unavailable;
          release = beginWorkspaceOperation(grant.workspaceId);
          if (!release) throw new Error("Workspace closing");
          // A bound operation must reach its executor even after expiry or revocation,
          // so owner-only native cancellation can stop it without authorizing new work.
          if (!active.native || !row.nativeOperationId) {
            await assertLiveGrant(grant, "send");
            if (row.deadlineAt <= new Date())
              throw new Error("Deadline exceeded");
          }
          timeout = setTimeout(
            () => controller.abort(),
            Math.max(1, row.deadlineAt.getTime() - Date.now()),
          );
          const ownerSignal = runtimeAbortSignal();
          const signal = ownerSignal
            ? AbortSignal.any([ownerSignal, controller.signal])
            : controller.signal;
          watchdog = setInterval(() => {
            if (checking) return;
            checking = true;
            void (async () => {
              try {
                const current = await db.a2ATask.findUnique({ where: { id } });
                if (!current || current.leaseToken !== row.leaseToken)
                  controller.abort(
                    active.native
                      ? new PiRuntimeInterruptedError("Pi task claim changed.")
                      : undefined,
                  );
                else if (current.cancelRequestedAt) controller.abort();
                else await assertLiveGrant(grant, "send");
              } catch {
                controller.abort();
              } finally {
                checking = false;
              }
            })();
          }, 1000);
          const result = await executor(row, signal);
          const nativeOperationId = result.nativeOperationId;
          if (result.deferred) {
            if (!isRemoteGrant(grant))
              throw new Error(
                "Only remote observations can defer an execution",
              );
            return;
          }
          if (active.native) {
            if (
              !nativeOperationId ||
              ![
                TaskState.TASK_STATE_COMPLETED,
                TaskState.TASK_STATE_REJECTED,
                TaskState.TASK_STATE_CANCELED,
                TaskState.TASK_STATE_FAILED,
              ].includes(result.state)
            )
              throw new Error(
                "PI_PROTOCOL_ERROR: Invalid native terminal result.",
              );
          } else {
            signal.throwIfAborted();
            await assertLiveGrant(grant, "send");
            if (
              ![
                TaskState.TASK_STATE_COMPLETED,
                TaskState.TASK_STATE_INPUT_REQUIRED,
                TaskState.TASK_STATE_AUTH_REQUIRED,
                TaskState.TASK_STATE_REJECTED,
                TaskState.TASK_STATE_FAILED,
              ].includes(result.state)
            )
              throw new Error("Invalid executor state");
          }
          const leaseToken = row.leaseToken;
          if (!leaseToken) throw new Error("Task execution lease unavailable.");
          await finishTask(
            id,
            leaseToken,
            result.state,
            result.message,
            result.artifact,
            active.native && nativeOperationId
              ? { nativeOperationId }
              : undefined,
          );
        } catch (error) {
          if (
            active.native &&
            (error instanceof PiRuntimeInterruptedError ||
              controller.signal.reason instanceof PiRuntimeInterruptedError ||
              runtimeAbortSignal()?.aborted ||
              !runtimeCanOperate())
          ) {
            if (row.leaseToken) await releasePiHarnessClaim(id, row.leaseToken);
            return;
          }
          if (active.native && row.leaseToken) {
            // Prepare may have bound an operation after the original claim was read.
            const current = await db.a2ATask.findUnique({
              where: { id },
              select: { leaseToken: true, nativeOperationId: true },
            });
            if (current?.leaseToken === row.leaseToken)
              await finishTask(
                id,
                row.leaseToken,
                TaskState.TASK_STATE_FAILED,
                nativeFailure(error),
                undefined,
                current.nativeOperationId
                  ? { nativeOperationId: current.nativeOperationId }
                  : undefined,
              );
            return;
          }
          // Remote dispatch remains send-once: only its existing observer may reconnect.
          if (isRemoteGrant(grant)) {
            await interruptTask(
              id,
              "The remote operation was interrupted without automatic replay.",
            );
            return;
          }
          if (row.leaseToken)
            await finishTask(
              id,
              row.leaseToken,
              TaskState.TASK_STATE_FAILED,
              "Task execution stopped or failed. No automatic replay was performed.",
            );
          else throw error;
        } finally {
          clearTimeout(timeout);
          clearInterval(watchdog);
          release?.();
        }
      },
      true,
    );
  };
  return trackRuntimeOperation(async () => {
    const queued = await db.a2ATask.findUnique({ where: { id } });
    if (!queued || state.stopped || !runtimeCanOperate()) return;
    active.native = queued.executionBackend === "pi-harness";
    const grant = queued.grant as unknown as TaskGrant;
    const run = () => {
      if (
        !active.native &&
        [...state.active.values()].filter(
          (entry) => entry.running && !entry.native,
        ).length >= A2A_LIMITS.workerConcurrency
      )
        return Promise.resolve();
      active.running = true;
      return operation();
    };
    if (!isLocalGrant(grant)) return run();
    let reserved = false;
    try {
      let sandboxId: string;
      if (active.native && queued.nativeOperationId) {
        // Resolve only the assigned workspace sandbox. The executor separately
        // chooses authorized drive or owner-only cleanup; this grants no model call.
        const assigned = await db.agentSandbox.findMany({
          where: {
            agentId: grant.agentId,
            agent: { workspaceId: grant.workspaceId },
            sandbox: { workspaceId: grant.workspaceId, kind: "docker" },
          },
          select: { sandboxId: true },
        });
        if (assigned.length !== 1) throw new Error("PI_TARGET_UNAVAILABLE");
        sandboxId = assigned[0].sandboxId;
      } else {
        sandboxId = (
          await localTarget(
            db,
            grant.workspaceId,
            grant.agentId,
            grant.ancestorTaskIds.length === 0
              ? grant.entryPolicy
              : "delegation",
          )
        ).sandboxId;
      }
      // Gate reentrancy belongs to one task's executor, not a child inheriting
      // the parent's async context. Busy roots queue; busy children fail promptly.
      if (sandboxExecutionBusy(sandboxId))
        throw new SandboxExecutionBusyError();
      return await withSandboxExecutionLease(sandboxId, () => {
        reserved = true;
        return run();
      });
    } catch (error) {
      if (reserved) throw error;
      if (
        active.native &&
        (state.stopped || runtimeAbortSignal()?.aborted || !runtimeCanOperate())
      )
        return;
      if (
        error instanceof SandboxExecutionBusyError &&
        !grant.ancestorTaskIds.length
      )
        return;
      const failure =
        error instanceof SandboxExecutionBusyError
          ? error
          : new Error("PI_TARGET_UNAVAILABLE");
      if (active.native && queued.nativeOperationId) return operation(failure);
      await interruptTask(
        id,
        active.native
          ? nativeFailure(failure)
          : error instanceof SandboxExecutionBusyError
            ? "The target Agent sandbox is busy; the child task was not started."
            : "Local execution is unavailable.",
      );
    }
  }).finally(() => state.active.delete(id));
}
export async function tickA2AWorker() {
  if (state.ticking || state.stopped || !runtimeCanOperate()) return;
  state.ticking = true;
  try {
    await reconcileLocalWaits();
    void reconcileRemoteTasks().catch(() =>
      systemLog("error", "Remote A2A observation failed."),
    );
    const expired = await db.a2ATask.findMany({
      where: {
        deadlineAt: { lte: new Date() },
        NOT: {
          executionBackend: "pi-harness",
          nativeOperationId: { not: null },
        },
        OR: [
          { state: { in: [1, 6, 8] } },
          { state: 2, phase: { in: ["waiting", "resumable"] } },
        ],
      },
      take: 50,
      select: { id: true },
    });
    for (const task of expired)
      await interruptTask(task.id, "Task deadline exceeded.");
    const ready = [
      { state: TaskState.TASK_STATE_SUBMITTED },
      { state: TaskState.TASK_STATE_WORKING, phase: "resumable" },
    ];
    // Separate pages keep queued legacy work from hiding native cleanup/recovery
    // when the legacy slots are occupied. Workspace quotas still bound admission.
    const queues = await Promise.all(
      ["pi-harness", "legacy"].map((executionBackend) =>
        db.a2ATask.findMany({
          where: { executionBackend, OR: ready },
          orderBy: [{ depth: "desc" }, { createdAt: "asc" }],
          take: 16,
          select: { id: true },
        }),
      ),
    );
    for (const rows of queues)
      for (const row of rows) {
        void executeA2ATask(row.id).catch(() =>
          systemLog("error", "A2A task could not be settled."),
        );
      }
    if (Date.now() - state.prunedAt > 60_000) {
      state.prunedAt = Date.now();
      const contexts = await db.a2AContext.findMany({
        where: {
          expiresAt: { lte: new Date() },
          tasks: { none: { state: { in: [...ACTIVE, 6, 8] } } },
        },
        take: 25,
        select: { id: true },
      });
      if (contexts.length)
        await db.a2AContext.deleteMany({
          where: {
            id: { in: contexts.map((row) => row.id) },
            tasks: { none: { state: { in: [...ACTIVE, 6, 8] } } },
          },
        });
    }
  } finally {
    state.ticking = false;
  }
}
export async function startA2AWorker() {
  assertRuntimeOwner();
  if (state.timer) return;
  // External processes have already been reconciled under the runtime owner.
  // Dirty-owner acknowledgement remains mandatory before reaching this point.
  let rows: Pick<
    A2ATask,
    "id" | "executionBackend" | "leaseToken" | "remoteTaskId" | "grant"
  >[];
  do {
    rows = await db.a2ATask.findMany({
      where: { state: TaskState.TASK_STATE_WORKING, phase: "executing" },
      take: 50,
      select: {
        id: true,
        executionBackend: true,
        leaseToken: true,
        remoteTaskId: true,
        grant: true,
      },
    });
    for (const task of rows) {
      if (task.executionBackend === "pi-harness") {
        await db.a2ATask.updateMany({
          where: {
            id: task.id,
            executionBackend: "pi-harness",
            state: TaskState.TASK_STATE_WORKING,
            phase: "executing",
            leaseToken: task.leaseToken,
          },
          data: {
            phase: "resumable",
            leaseToken: null,
            approvalReadyLease: null,
          },
        });
      } else if (
        task.remoteTaskId &&
        isRemoteGrant(task.grant as unknown as TaskGrant)
      ) {
        // Only read an already-known remote task after restart. Never replay SendMessage.
        await db.a2ATask.update({
          where: { id: task.id },
          data: {
            phase: "remote-waiting",
            leaseToken: null,
            remotePollAt: new Date(),
          },
        });
      } else
        await interruptTask(
          task.id,
          "Execution was interrupted by a process restart.",
        );
    }
  } while (rows.length === 50);
  state.stopped = false;
  state.timer = setInterval(() => {
    void tickA2AWorker().catch(() =>
      systemLog("error", "A2A scheduling failed."),
    );
  }, 500);
  state.timer.unref?.();
}
export function stopA2AWorker() {
  state.stopped = true;
  clearInterval(state.timer);
  state.timer = undefined;
  for (const { controller, native } of state.active.values())
    controller.abort(
      native ? new PiRuntimeInterruptedError("Pi worker stopped.") : undefined,
    );
}
export function wakeA2AWorker() {
  void tickA2AWorker().catch(() =>
    systemLog("error", "A2A admission wake failed."),
  );
}
