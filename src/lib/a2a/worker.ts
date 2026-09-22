import 'server-only';
import { TaskState } from '@a2a-js/sdk';
import { db } from '@/lib/db';
import { assertRuntimeOwner, runtimeAbortSignal, runtimeCanOperate, trackRuntimeOperation } from '@/lib/runtime/ownership-state';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { withLogContext } from '@/lib/observability/context';
import { systemLog } from '@/lib/observability/system';
import { ACTIVE, A2A_LIMITS } from './model';
import { claimTask, finishTask, interruptTask } from './store';
import { assertLiveGrant, type A2AGrant } from './principal';
import { executePublishedTask, type TaskExecutor } from './executor';

type State = { active: Map<string, AbortController>; ticking: boolean; stopped: boolean; timer?: ReturnType<typeof setInterval>; prunedAt: number };
const globalState = globalThis as typeof globalThis & { __nativeA2AWorker?: State };
const state: State = globalState.__nativeA2AWorker ??= { active: new Map(), ticking: false, stopped: false, prunedAt: 0 };
export function executeA2ATask(id: string, executor: TaskExecutor = executePublishedTask) {
  if (state.stopped || !runtimeCanOperate() || state.active.has(id) || state.active.size >= A2A_LIMITS.workerConcurrency) return Promise.resolve();
  const controller = new AbortController(); state.active.set(id, controller);
  return trackRuntimeOperation(async () => {
    let claimed: Awaited<ReturnType<typeof claimTask>> = null;
    let release: (() => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    try {
      claimed = await claimTask(id); if (!claimed) return;
      const row = claimed;
      const grant = row.grant as unknown as A2AGrant;
      release = beginWorkspaceOperation(grant.workspaceId);
      if (!release) throw new Error('Workspace closing');
      await assertLiveGrant(grant, 'send');
      if (row.deadlineAt <= new Date()) throw new Error('Deadline exceeded');
      timeout = setTimeout(() => controller.abort(), Math.max(1, row.deadlineAt.getTime() - Date.now()));
      const ownerSignal = runtimeAbortSignal();
      const signal = ownerSignal ? AbortSignal.any([ownerSignal, controller.signal]) : controller.signal;
      watchdog = setInterval(() => {
        if (checking) return; checking = true;
        void (async () => {
          try {
            const current = await db.a2ATask.findUnique({ where: { id } });
            if (!current || current.cancelRequestedAt || current.leaseToken !== row.leaseToken) controller.abort();
            else await assertLiveGrant(grant, 'send');
          } catch { controller.abort(); }
          finally { checking = false; }
        })();
      }, 1000);
      const result = await withLogContext({ workspaceId: grant.workspaceId, suppressPayload: true }, () => executor(row, signal));
      signal.throwIfAborted(); await assertLiveGrant(grant, 'send');
      if (![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_AUTH_REQUIRED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_FAILED].includes(result.state)) throw new Error('Invalid executor state');
      await finishTask(id, row.leaseToken!, result.state, result.message, result.artifact);
    } catch {
      // Native exception text may contain prompts, files or upstream credentials.
      if (claimed?.leaseToken) await finishTask(id, claimed.leaseToken, TaskState.TASK_STATE_FAILED,
        'Task execution stopped or failed. No automatic replay was performed.');
    } finally {
      if (timeout) clearTimeout(timeout); if (watchdog) clearInterval(watchdog);
      release?.(); state.active.delete(id);
    }
  }).finally(() => state.active.delete(id));
}
export async function tickA2AWorker() {
  if (state.ticking || state.stopped || !runtimeCanOperate()) return;
  state.ticking = true;
  try {
    const expired = await db.a2ATask.findMany({ where: { deadlineAt: { lte: new Date() }, state: { in: [1, 6, 8] } }, take: 50, select: { id: true } });
    for (const task of expired) await interruptTask(task.id, 'Task deadline exceeded.');
    const queued = await db.a2ATask.findMany({ where: { state: TaskState.TASK_STATE_SUBMITTED }, orderBy: { createdAt: 'asc' }, take: 16, select: { id: true } });
    for (const row of queued) {
      if (state.active.size >= A2A_LIMITS.workerConcurrency) break;
      void executeA2ATask(row.id).catch(() => systemLog('error', 'A2A task could not be settled.'));
    }
    if (Date.now() - state.prunedAt > 60_000) {
      state.prunedAt = Date.now();
      const contexts = await db.a2AContext.findMany({ where: { expiresAt: { lte: new Date() }, tasks: { none: { state: { in: [...ACTIVE, 6, 8] } } } }, take: 25, select: { id: true } });
      if (contexts.length) await db.a2AContext.deleteMany({ where: { id: { in: contexts.map((row) => row.id) }, tasks: { none: { state: { in: [...ACTIVE, 6, 8] } } } } });
    }
  } finally { state.ticking = false; }
}
export async function startA2AWorker() {
  assertRuntimeOwner(); if (state.timer) return;
  // The runtime owner has recovered external processes first. Never re-run an uncertain side effect.
  let rows;
  do {
    rows = await db.a2ATask.findMany({ where: { state: TaskState.TASK_STATE_WORKING }, take: 50, select: { id: true } });
    for (const row of rows) await interruptTask(row.id, 'Execution was interrupted by a process restart.');
  } while (rows.length === 50);
  state.stopped = false;
  state.timer = setInterval(() => { void tickA2AWorker().catch(() => systemLog('error', 'A2A scheduling failed.')); }, 500);
  state.timer.unref?.();
}
export function stopA2AWorker() {
  state.stopped = true;
  if (state.timer) clearInterval(state.timer); state.timer = undefined;
  for (const controller of state.active.values()) controller.abort();
}
export function wakeA2AWorker() { void tickA2AWorker().catch(() => systemLog('error', 'A2A admission wake failed.')); }
