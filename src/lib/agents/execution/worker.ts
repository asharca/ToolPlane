import "server-only";
import { tickEvolutionJobs } from "@/lib/agents/evolution/jobs";
import { recordEpisode } from "@/lib/agents/evolution/service";
import { A2AQuotaError } from "@/lib/a2a/quotas";
import { TaskState } from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { AgentRevisionError } from "@/lib/agents/revisions";
import { PluginError } from "@/lib/plugins/errors";
import { Prisma, type A2ATask } from "@prisma/client";
import { localTargetReason } from "@/lib/a2a/local-policy";
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
import { logSystemEvent } from "@/lib/observability/system";
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
  sandboxSessionBusy,
  withSandboxSessionLease,
  SandboxExecutionBusyError,
} from "@/lib/agents/sandbox-execution-gate";
import { PiRuntimeInterruptedError } from "@/lib/agents/pi-harness";
import { parseRuntimeFailure } from "@/lib/agents/runtime-failure";
import { recordSystemFailureFeedback } from "@/lib/feedback/service";
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
import {
  localTaskSandbox,
  type LocalTaskSandboxLease,
} from "@/lib/a2a/local-sandbox";
import { deleteAgentContextSandbox } from "@/lib/agents/conversation-sandbox";
import { stageTaskFileTransfers } from "@/lib/a2a/task-files";
import { cleanupTaskFiles } from "@/lib/a2a/files";
import { cleanupAttachmentUploads } from "@/lib/attachments/uploads";
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
  maintaining?: boolean;
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
function preparationFailure(error: unknown, native: boolean) {
  if (error instanceof PluginError && error.code === "listing_unavailable")
    return "PI_PACKAGE_UNAVAILABLE: A pinned package is unavailable.";
  if (
    error instanceof A2AQuotaError ||
    (error instanceof Error && parseRuntimeFailure(error.message))
  )
    return nativeFailure(error);
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError
  )
    return "PI_TASK_STORAGE_UNAVAILABLE: The task preparation database operation failed.";
  if (error instanceof TaskNotFoundError && localTargetReason(error))
    return "PI_TARGET_UNAVAILABLE: The Agent target is unavailable.";
  if (
    error instanceof TaskNotFoundError ||
    error instanceof UnsupportedOperationError ||
    error instanceof AgentRevisionError
  )
    return "PI_TASK_AUTH_REVOKED: The Agent or session is no longer authorized for this task.";
  return native
    ? "PI_TARGET_UNAVAILABLE: The bound Agent target is unavailable."
    : "PI_SANDBOX_PREPARATION_FAILED: The Agent sandbox could not be prepared.";
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
  const operation = async (mapping?: LocalTaskSandboxLease["mapping"]) => {
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
          const result = await executor(
            row,
            signal,
            mapping && row.leaseToken
              ? { taskId: row.id, leaseToken: row.leaseToken, mapping }
              : undefined,
          );
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
          if (result.state === TaskState.TASK_STATE_FAILED) {
            const parsedFailure = parseRuntimeFailure(result.message);
            if (parsedFailure) {
              await db
                .$transaction((tx) =>
                  recordSystemFailureFeedback(tx, {
                    code: parsedFailure.code,
                    reason: parsedFailure.reason ?? null,
                    stage: "execution",
                    runtimeKind: row.executionBackend,
                    sourceKind: "a2a_task",
                    sourceId: id,
                    workspaceId: grant.workspaceId,
                    agentId: isLocalGrant(grant) ? grant.agentId : null,
                    conversationId: isLocalGrant(grant)
                      ? (grant.entryPolicy?.conversationId ?? null)
                      : null,
                    taskId: id,
                  }),
                )
                .catch(() => {});
            }
          }
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
            if (current?.leaseToken === row.leaseToken) {
              const failureMessage = nativeFailure(error);
              await finishTask(
                id,
                row.leaseToken,
                TaskState.TASK_STATE_FAILED,
                failureMessage,
                undefined,
                current.nativeOperationId
                  ? { nativeOperationId: current.nativeOperationId }
                  : undefined,
              );
              const parsedFailure = parseRuntimeFailure(failureMessage);
              if (parsedFailure) {
                await db
                  .$transaction((tx) =>
                    recordSystemFailureFeedback(tx, {
                      code: parsedFailure.code,
                      reason: parsedFailure.reason ?? null,
                      stage: "execution",
                      runtimeKind: row.executionBackend,
                      sourceKind: "a2a_task",
                      sourceId: id,
                      workspaceId: grant.workspaceId,
                      agentId: isLocalGrant(grant) ? grant.agentId : null,
                      conversationId: isLocalGrant(grant)
                        ? (grant.entryPolicy?.conversationId ?? null)
                        : null,
                      taskId: id,
                    }),
                  )
                  .catch(() => {});
              }
            }
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
          if (row.leaseToken) {
            const failureMessage = nativeFailure(error);
            await finishTask(
              id,
              row.leaseToken,
              TaskState.TASK_STATE_FAILED,
              failureMessage,
            );
            const parsedFailure = parseRuntimeFailure(failureMessage);
            if (parsedFailure) {
              await db
                .$transaction((tx) =>
                  recordSystemFailureFeedback(tx, {
                    code: parsedFailure.code,
                    reason: parsedFailure.reason ?? null,
                    stage: "execution",
                    runtimeKind: row.executionBackend,
                    sourceKind: "a2a_task",
                    sourceId: id,
                    workspaceId: grant.workspaceId,
                    agentId: isLocalGrant(grant) ? grant.agentId : null,
                    conversationId: isLocalGrant(grant)
                      ? (grant.entryPolicy?.conversationId ?? null)
                      : null,
                    taskId: id,
                  }),
                )
                .catch(() => {});
            }
          } else throw error;
        } finally {
          clearTimeout(timeout);
          clearInterval(watchdog);
          release?.();
          await recordAgentTaskUsage(row, metering);
          await recordEpisode(row);
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
    const run = (mapping?: LocalTaskSandboxLease["mapping"]) => {
      if (
        !active.native &&
        !active.local &&
        [...state.active.values()].filter(
          (entry) => entry.running && !entry.native && !entry.local,
        ).length >= A2A_LIMITS.workerConcurrency
      )
        return Promise.resolve();
      active.running = true;
      return operation(mapping);
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
          const mapping = await localTaskSandbox(
            queued,
            cleanup ? "cleanup" : "admit",
            controller.signal,
          );
          const { sandboxId } = mapping;
          if (sandboxSessionBusy(sandboxId, sessionId))
            throw new SandboxExecutionBusyError();
          return withSandboxSessionLease(sandboxId, sessionId, () => {
            reserved = true;
            return run(cleanup ? undefined : mapping);
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
      if (active.native && queued.nativeOperationId)
        throw new PiRuntimeInterruptedError(
          "Bound native sandbox is unavailable; operation retained for recovery.",
          { cause: error },
        );
      const failure = preparationFailure(error, active.native);
      logSystemEvent("agent.task.preparation_failed", {
        domain: "agent",
        workspaceId: grant.workspaceId,
        taskId: id,
        errorCode: parseRuntimeFailure(failure)?.code,
      });
      await interruptTask(id, failure, {
        phase: queued.phase,
        remoteMessageId: queued.remoteMessageId,
        sequence: queued.sequence,
      });
    }
  }).finally(() => state.active.delete(id));
}
const EXPIRY_CONCURRENCY = 4;
type ExpiryCandidate = Pick<
  A2ATask,
  "id" | "phase" | "remoteMessageId" | "sequence"
>;

async function expireTasks(
  rows: ExpiryCandidate[],
  reason: "deadline" | "retention",
) {
  const detail =
    reason === "deadline"
      ? "Task deadline exceeded."
      : "File reception retention expired. The observed remote outcome remains in task metadata.";
  for (let offset = 0; offset < rows.length; offset += EXPIRY_CONCURRENCY) {
    const batch = rows.slice(offset, offset + EXPIRY_CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        try {
          await interruptTask(row.id, detail, row);
          if (reason === "deadline") {
            const task = await db.a2ATask.findUnique({ where: { id: row.id } });
            if (task) await recordEpisode(task);
          }
        } catch {
          logSystemEvent("a2a.task.expiry_failed", {
            domain: "a2a",
            taskId: row.id,
            errorCode: "A2A_EXPIRY_FAILED",
          });
        }
      }),
    );
  }
}

async function maintainAgentTasks() {
  if (state.maintaining) return;
  state.maintaining = true;
  try {
    void tickEvolutionJobs().catch(() =>
      logSystemEvent("agent.evolution.tick_failed", {
        domain: "agent",
        errorCode: "EVOLUTION_FAILED",
      }),
    );
    void reconcileRemoteTasks().catch((error) =>
      logSystemEvent("a2a.remote.reconcile_failed", { domain: "a2a", error }),
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
      orderBy: [{ deadlineAt: "asc" }, { id: "asc" }],
      take: 50,
      select: { id: true, phase: true, remoteMessageId: true, sequence: true },
    });
    await expireTasks(expired, "deadline");
    await reconcileLocalWaits();
    if (Date.now() - state.prunedAt > 60_000) {
      state.prunedAt = Date.now();
      await cleanupAttachmentUploads();
      await cleanupTaskFiles();
      const staleDelivery = await db.a2ATask.findMany({
        where: {
          state: TaskState.TASK_STATE_WORKING,
          phase: { in: ["remote-file-receiving", "remote-file-failed"] },
          context: { expiresAt: { lte: new Date() } },
        },
        select: {
          id: true,
          phase: true,
          remoteMessageId: true,
          sequence: true,
        },
        orderBy: { id: "asc" },
        take: 50,
      });
      await expireTasks(staleDelivery, "retention");
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
    state.maintaining = false;
  }
}

async function admitReadyTasks() {
  if (state.ticking) return;
  state.ticking = true;
  try {
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
    const now = new Date();
    // Separate pages keep remote observations from hiding SDK admission or bound cleanup.
    // Retired published queues never acquire a new execution lease.
    const queues = await Promise.all(
      [
        {
          executionBackend: "pi-harness",
          AND: [
            {
              OR: [
                { deadlineAt: { gt: now } },
                { nativeOperationId: { not: null } },
              ],
            },
          ],
        },
        {
          executionBackend: { in: ["pi-sdk"] },
          deadlineAt: { gt: now },
          context: { targetKind: "local" },
        },
        {
          executionBackend: "legacy",
          AND: [
            {
              OR: [
                { deadlineAt: { gt: now } },
                {
                  phase: "remote-file-receiving",
                  remoteObservedState: { in: [3, 4, 5, 7] },
                },
              ],
            },
          ],
          context: { targetKind: "remote" },
        },
      ].map((scope) =>
        db.a2ATask.findMany({
          where: { ...scope, OR: ready },
          orderBy: [{ depth: "desc" }, { createdAt: "asc" }, { id: "asc" }],
          take: 16,
          select: { id: true },
        }),
      ),
    );
    for (const rows of queues)
      for (const row of rows) {
        void executeAgentTask(row.id).catch((error) =>
          logSystemEvent("agent.task.settle_failed", {
            domain: "agent",
            taskId: row.id,
            error,
          }),
        );
      }
  } finally {
    state.ticking = false;
  }
}

export async function tickAgentWorker() {
  if (state.stopped || !runtimeCanOperate()) return;
  await Promise.all([maintainAgentTasks(), admitReadyTasks()]);
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
    void tickAgentWorker().catch((error) =>
      logSystemEvent("scheduler.agents.tick_failed", { error }),
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
  void tickAgentWorker().catch((error) =>
    logSystemEvent("scheduler.agents.wake_failed", { error }),
  );
}
