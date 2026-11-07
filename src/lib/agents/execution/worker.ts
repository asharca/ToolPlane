import "server-only";
import { A2AQuotaError } from "@/lib/a2a/quotas";
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
import { recordEvent } from "@/lib/observability/events";
import { isEntryRootGrant } from "@/lib/observability/views/task-origin";
import { systemLog } from "@/lib/observability/system";
import { ACTIVE, A2A_LIMITS } from "@/lib/a2a/model";
import {
  claimTask,
  finishTask,
  interruptTask,
  releasePiHarnessClaim,
  deferTaskFileStaging,
  recordTaskExecutionStage,
} from "@/lib/a2a/store";
import {
  assertLiveGrant,
  isLocalGrant,
  isRemoteGrant,
  type TaskGrant,
} from "@/lib/a2a/principal";
import {
  sandboxExecutionBusy,
  withSandboxExecutionLease,
  SandboxExecutionBusyError,
} from "@/lib/agents/sandbox-execution-gate";
import { PiRuntimeInterruptedError } from "@/lib/agents/pi-harness";
import { parseRuntimeFailure } from "@/lib/agents/runtime-failure";
import { reconcileLocalWaits } from "@/lib/a2a/local-continuation";
import { reconcileRemoteTasks } from "@/lib/a2a/remote-executor";
import {
  executeTask,
  type TaskExecutor,
} from "@/lib/agents/execution/executor";
import {
  AgentExecutionBusyError,
  withAgentExecutionLease,
} from "@/lib/agents/agent-execution-gate";
import { localTaskSandbox } from "@/lib/a2a/local-sandbox";
import { deleteAgentContextSandbox } from "@/lib/agents/conversation-sandbox";
import { stageTaskFileTransfers } from "@/lib/a2a/task-files";
import { cleanupTaskFiles } from "@/lib/a2a/files";
import { workRuntimeObserver } from "@/lib/work/run-control";
import {
  MeteredExecutionError,
  recordAgentTaskUsage,
  type TaskUsage,
} from "@/lib/agents/usage";
import { settleAgentTriggerTask } from "@/lib/agents/triggers";
import { startTaskOutput } from "./live-output";

type ActiveExecution = {
  controller: AbortController;
  native: boolean;
  local: boolean;
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
  if (
    error instanceof SandboxExecutionBusyError ||
    error instanceof AgentExecutionBusyError
  )
    return "PI_SANDBOX_BUSY: The target Agent/session is busy; execution was not started.";
  // Storage exhaustion is a platform decision, not an opaque Pi crash.
  if (error instanceof A2AQuotaError)
    return "PI_STORAGE_QUOTA_EXCEEDED: The task payload exceeded the configured storage budget; the result was not stored.";
  // Only fixed tokens may escape: native exception text can contain credentials or task content.
  const failure =
    error instanceof Error ? parseRuntimeFailure(error.message) : undefined;
  return `${failure?.code ?? "PI_EXECUTION_FAILED"}: ${failure?.reason ? `${failure.reason}. ` : ""}Agent task execution failed. No automatic replay was performed.`;
}
export function executeAgentTask(
  id: string,
  executor: TaskExecutor = executeTask,
) {
  if (state.stopped || !runtimeCanOperate() || state.active.has(id))
    return Promise.resolve();
  const controller = new AbortController();
  const active: ActiveExecution = {
    controller,
    native: false,
    local: false,
    running: false,
  };
  state.active.set(id, active);
  const operation = async () => {
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
    if (isLocalGrant(grant) && row.executionBackend === "pi-sdk")
      startTaskOutput(row.id, { runtimeKind: "pi-sdk" });
    return withLogContext(
      {
        workspaceId: grant.workspaceId,
        taskId: row.id,
        ...(isLocalGrant(grant) &&
        grant.entryPolicy &&
        isEntryRootGrant(grant, row.parentTaskId)
          ? {
              conversationId:
                grant.entryPolicy.kind === "work"
                  ? grant.entryPolicy.conversationId
                  : (grant.entryPolicy.conversationId ??
                    grant.entryPolicy.sourceId),
            }
          : {}),
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
        let metering: TaskUsage | undefined;
        try {
          if (
            isLocalGrant(grant) &&
            grant.entryPolicy &&
            isEntryRootGrant(grant, row.parentTaskId)
          ) {
            await recordEvent({
              domain: "agent",
              eventName: "agent.execution.started",
              workspaceId: grant.workspaceId,
              agentId: grant.agentId,
              actorId: grant.actorId,
              conversationId:
                grant.entryPolicy.kind === "work"
                  ? grant.entryPolicy.conversationId
                  : (grant.entryPolicy.conversationId ??
                    grant.entryPolicy.sourceId),
              attributes: {
                taskId: row.id,
                contextId: row.contextId,
                entryKind: grant.entryPolicy.kind,
              },
            });
          } else {
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
          }
          if (
            active.native &&
            (controller.signal.reason instanceof PiRuntimeInterruptedError ||
              !runtimeCanOperate())
          )
            throw new PiRuntimeInterruptedError();
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
        } catch (cause) {
          const error =
            cause instanceof MeteredExecutionError ? cause.cause : cause;
          if (cause instanceof MeteredExecutionError) {
            metering = cause.metering;
          }
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "A2A_SANDBOX_FILE_STAGING_FAILED" &&
            row.leaseToken &&
            !controller.signal.aborted &&
            runtimeCanOperate()
          ) {
            await deferTaskFileStaging(id, row.leaseToken);
            return;
          }
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
              nativeFailure(error),
            );
          else throw error;
        } finally {
          clearTimeout(timeout);
          clearInterval(watchdog);
          release?.();
          await recordAgentTaskUsage(row, metering);
          await settleAgentTriggerTask(row);
        }
      },
      true,
    );
  };
  return trackRuntimeOperation(async () => {
    let queued = await db.a2ATask.findUnique({ where: { id } });
    if (!queued || state.stopped || !runtimeCanOperate()) return;
    if (["file-receiving", "remote-file-receiving"].includes(queued.phase)) {
      const grant = queued.grant as unknown as TaskGrant;
      const release = beginWorkspaceOperation(grant.workspaceId);
      if (!release) return;
      try {
        await stageTaskFileTransfers(id, controller.signal);
      } finally {
        release();
      }
      queued = await db.a2ATask.findUnique({ where: { id } });
      if (!queued || state.stopped || !runtimeCanOperate()) return;
    }
    if (
      !(
        (queued.state === TaskState.TASK_STATE_SUBMITTED &&
          queued.phase === "queued") ||
        (queued.state === TaskState.TASK_STATE_WORKING &&
          ["resumable", "file-stage-ready"].includes(queued.phase))
      )
    )
      return;
    active.native = queued.executionBackend === "pi-harness";
    const grant = queued.grant as unknown as TaskGrant;
    active.local = isLocalGrant(grant);
    const run = () => {
      if (
        !active.native &&
        !active.local &&
        [...state.active.values()].filter(
          (entry) => entry.running && !entry.native && !entry.local,
        ).length >= A2A_LIMITS.workerConcurrency
      )
        return Promise.resolve();
      active.running = true;
      return operation();
    };
    if (!isLocalGrant(grant)) return run();
    let reserved = false;
    const observer =
      !grant.ancestorTaskIds.length && grant.entryPolicy?.kind === "work"
        ? workRuntimeObserver(grant.entryPolicy.sourceId)
        : undefined;
    try {
      const work =
        !grant.ancestorTaskIds.length && grant.entryPolicy?.kind === "work"
          ? await db.workSession.findFirst({
              where: {
                id: grant.entryPolicy.sourceId,
                workspaceId: grant.workspaceId,
                agentId: grant.agentId,
              },
              select: { conversationId: true },
            })
          : null;
      const sessionId =
        !grant.ancestorTaskIds.length && grant.entryPolicy
          ? (work?.conversationId ??
            grant.entryPolicy.conversationId ??
            grant.entryPolicy.sourceId)
          : queued.contextId;
      return await withAgentExecutionLease(
        {
          agentId: grant.agentId,
          sessionId,
          signal: controller.signal,
          wait: false,
        },
        async () => {
          if (!active.native)
            await recordTaskExecutionStage(id, queued.leaseToken, "preparing");
          await observer?.onExecutionStage?.("preparing");
          const cleanup = Boolean(active.native && queued.nativeOperationId);
          const { sandboxId } = await localTaskSandbox(
            queued,
            cleanup,
            controller.signal,
          );
          if (sandboxExecutionBusy(sandboxId))
            throw new SandboxExecutionBusyError();
          return withSandboxExecutionLease(sandboxId, () => {
            reserved = true;
            return run();
          });
        },
      );
    } catch (error) {
      if (reserved) throw error;
      if (
        active.native &&
        (state.stopped || runtimeAbortSignal()?.aborted || !runtimeCanOperate())
      )
        return;
      if (
        error instanceof SandboxExecutionBusyError ||
        error instanceof AgentExecutionBusyError
      ) {
        if (!active.native)
          await recordTaskExecutionStage(id, queued.leaseToken, "queued");
        await observer?.onExecutionStage?.("queued");
        return;
      }
      const failure =
        error instanceof SandboxExecutionBusyError ||
        error instanceof AgentExecutionBusyError
          ? error
          : new Error("PI_TARGET_UNAVAILABLE");
      if (active.native && queued.nativeOperationId)
        throw new PiRuntimeInterruptedError(
          "Bound native sandbox is unavailable; operation retained for recovery.",
          { cause: error },
        );
      await interruptTask(
        id,
        active.native
          ? nativeFailure(failure)
          : error instanceof SandboxExecutionBusyError ||
              error instanceof AgentExecutionBusyError
            ? "The target Agent sandbox is busy; the child task was not started."
            : "Local execution is unavailable.",
      );
    }
  }).finally(() => state.active.delete(id));
}
export async function tickAgentWorker() {
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
        AND: [
          {
            OR: [
              { remoteObservedState: null },
              { remoteObservedState: { notIn: [3, 4, 5, 7] } },
            ],
          },
        ],
        OR: [
          { state: { in: [1, 6, 8] } },
          {
            state: 2,
            phase: {
              in: [
                "waiting",
                "resumable",
                "file-stage-ready",
                "file-staging-failed",
                "remote-file-receiving",
                "remote-file-failed",
              ],
            },
          },
        ],
      },
      take: 50,
      select: { id: true },
    });
    for (const task of expired)
      await interruptTask(task.id, "Task deadline exceeded.");
    const ready = [
      {
        state: TaskState.TASK_STATE_SUBMITTED,
        phase: { in: ["queued", "file-receiving"] },
      },
      {
        state: TaskState.TASK_STATE_WORKING,
        phase: {
          in: ["resumable", "file-stage-ready", "remote-file-receiving"],
        },
      },
    ];
    // Separate pages keep remote observations from hiding SDK admission or bound cleanup.
    // Retired published queues never acquire a new execution lease.
    const queues = await Promise.all(
      [
        { executionBackend: "pi-harness" },
        {
          executionBackend: { in: ["pi-sdk"] },
          context: { targetKind: "local" },
        },
        {
          executionBackend: "legacy",
          context: { targetKind: "remote" },
        },
      ].map((scope) =>
        db.a2ATask.findMany({
          where: { ...scope, OR: ready },
          orderBy: [{ depth: "desc" }, { createdAt: "asc" }],
          take: 16,
          select: { id: true },
        }),
      ),
    );
    for (const rows of queues)
      for (const row of rows) {
        void executeAgentTask(row.id).catch(() =>
          systemLog("error", "A2A task could not be settled."),
        );
      }
    if (Date.now() - state.prunedAt > 60_000) {
      state.prunedAt = Date.now();
      await cleanupTaskFiles();
      const staleDelivery = await db.a2ATask.findMany({
        where: {
          state: TaskState.TASK_STATE_WORKING,
          phase: { in: ["remote-file-receiving", "remote-file-failed"] },
          context: { expiresAt: { lte: new Date() } },
        },
        select: { id: true },
        take: 50,
      });
      for (const task of staleDelivery)
        await interruptTask(
          task.id,
          "File reception retention expired. The observed remote outcome remains in task metadata.",
        );
      const contexts = await db.a2AContext.findMany({
        where: {
          expiresAt: { lte: new Date() },
          tasks: { none: { state: { in: [...ACTIVE, 6, 8] } } },
        },
        take: 25,
        select: { id: true, workspaceId: true, agentId: true },
      });
      for (const context of contexts)
        if (context.agentId)
          await deleteAgentContextSandbox({
            workspaceId: context.workspaceId,
            agentId: context.agentId,
            contextId: context.id,
          });
      if (contexts.length)
        await db.a2AContext.deleteMany({
          where: {
            id: { in: contexts.map((row) => row.id) },
            tasks: { none: { state: { in: [...ACTIVE, 6, 8] } } },
          },
        });
      // Task FK is SetNull: cascades retain cleanup records and paths until blob deletion succeeds.
      await cleanupTaskFiles();
    }
  } finally {
    state.ticking = false;
  }
}
export async function startAgentWorker() {
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
    void tickAgentWorker().catch(() =>
      systemLog("error", "Agent task scheduling failed."),
    );
  }, 500);
  state.timer.unref?.();
}
export function stopAgentWorker() {
  state.stopped = true;
  clearInterval(state.timer);
  state.timer = undefined;
  for (const { controller, native } of state.active.values())
    controller.abort(
      native ? new PiRuntimeInterruptedError("Pi worker stopped.") : undefined,
    );
}
export function wakeAgentWorker() {
  void tickAgentWorker().catch(() =>
    systemLog("error", "Agent task admission wake failed."),
  );
}
