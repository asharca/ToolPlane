import 'server-only';
import { Prisma, type AgentCollaborationTask } from '@prisma/client';
import { db } from '@/lib/db';
import { getAgentForRun } from '../queries';
import { resolveAgentTools } from '../resolve';
import { runDedicatedSandboxTurn } from '../sandbox-turn';
import { runtimeAbortSignal, runtimeCanOperate, trackRuntimeOperation } from '@/lib/runtime/ownership-state';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { systemLog } from '@/lib/observability/system';
import { withLogContext } from '@/lib/observability/context';
import { COLLABORATION_LIMITS as LIMITS, CollaborationError, terminal } from './protocol';
import { cancelTree, liveEdge, lockRoot, targetSnapshot } from './service';

type WorkerState = {
  active: Map<string, { targetId: string; depth: number; controller: AbortController }>;
  ticking: boolean; stopping: boolean; reconciled: boolean; prunedAt: number; timer?: ReturnType<typeof setInterval>;
};
const globalState = globalThis as typeof globalThis & { __collaborationWorker?: WorkerState };
const state: WorkerState = globalState.__collaborationWorker ??= { active: new Map(), ticking: false, stopping: false, reconciled: false, prunedAt: 0 };
export type CollaborationExecutor = (task: AgentCollaborationTask, signal: AbortSignal) => Promise<{ text: string; usage?: Prisma.InputJsonValue }>;

export const executeCollaborationTask: CollaborationExecutor = async (task, signal) => {
  const agent = await getAgentForRun(task.targetAgentId, task.workspaceId);
  if (!agent || agent.publicRuntimeAllocation) throw new CollaborationError('target_unavailable', 'Target unavailable.');
  const conversation = await db.conversation.findFirst({ where: { id: task.contextId, agentId: agent.id,
    agent: { workspaceId: task.workspaceId }, publicApiConversation: null },
    include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
  if (!conversation) throw new CollaborationError('context_lost', 'Delegation context was removed.');
  const resolved = resolveAgentTools(agent);
  let usage: Prisma.InputJsonValue | undefined;
  const text = await runDedicatedSandboxTurn({
    agent, runtimeSessionId: conversation.id,
    messages: [...conversation.messages.map((message) => ({ role: message.role,
      parts: Array.isArray(message.parts) ? message.parts as Array<{ type: string; text?: string }> : [] })),
      { role: 'user', parts: [{ type: 'text', text: task.message }] }],
    systemPrompt: agent.systemPrompt, skills: resolved.skills, deploymentIds: resolved.deploymentIds,
    collaboration: { targetIds: resolved.subAgents.map((sub) => sub.id), taskId: task.id }, signal,
    onUsage: (value) => { usage = JSON.parse(JSON.stringify(value)); },
  });
  return { text, usage };
};

async function validateTask(task: AgentCollaborationTask) {
  if (task.deadlineAt <= new Date()) throw new CollaborationError('deadline_exceeded', 'Task deadline exceeded.');
  if (!await db.agentCollaborationRun.count({ where: { id: task.rootId, workspaceId: task.workspaceId } })) throw new CollaborationError('authority_removed', 'Root execution authority was removed.');
  await liveEdge(db, task.workspaceId, task.callerAgentId, task.targetAgentId);
  const { binding } = await targetSnapshot(db, task.workspaceId, task.targetAgentId);
  if (binding !== task.targetBinding) throw new CollaborationError('configuration_changed', 'Target configuration changed.');
  if (task.requiresApproval && !task.approvedById) throw new CollaborationError('authorization_required', 'Task requires human authorization.');
  if (task.requiresApproval && !await db.workspace.count({ where: { id: task.workspaceId, status: 'active', OR: [
    { ownerId: task.approvedById!, owner: { status: 'active' } },
    { members: { some: { userId: task.approvedById!, user: { status: 'active' } } } },
  ] } })) throw new CollaborationError('authorization_revoked', 'The authorizing user no longer has access.');
  const run = await db.agentCollaborationRun.findUnique({ where: { id: task.runId } });
  if (!run || !run.allowedAgentIds.includes(task.targetAgentId)) throw new CollaborationError('revoked', 'Delegation authority was removed.');
  if (run.workSessionId && !await db.workSession.count({ where: { id: run.workSessionId, workspaceId: task.workspaceId,
    cancelRequestedAt: null, status: { notIn: ['failed', 'cancelling', 'archived'] } } })) throw new CollaborationError('work_canceled', 'Originating Work was canceled or failed.');
  if (task.ancestorTaskIds.length && await db.agentCollaborationTask.count({ where: { id: { in: task.ancestorTaskIds }, workspaceId: task.workspaceId } }) !== task.ancestorTaskIds.length) throw new CollaborationError('ancestor_removed', 'Ancestor task was removed.');
  if (task.ancestorTaskIds.length && await db.agentCollaborationTask.count({ where: { id: { in: task.ancestorTaskIds },
    OR: [{ state: { in: ['failed', 'canceled', 'rejected'] } }, { cancelRequestedAt: { not: null } }] } })) {
    throw new CollaborationError('ancestor_failed', 'An ancestor task failed or was canceled.');
  }
}

// Exported for integration tests. Claim with compare-and-set; errors are never
// converted to successful text artifacts. No automatic retry after side effects.
export function processCollaborationTask(id: string, executor: CollaborationExecutor = executeCollaborationTask, supplied?: AgentCollaborationTask) {
  return trackRuntimeOperation(() => processClaimedTask(id, executor, supplied));
}
async function processClaimedTask(id: string, executor: CollaborationExecutor, supplied?: AgentCollaborationTask) {
  if (state.stopping || !runtimeCanOperate() || state.active.has(id)) return;
  const initial = supplied ?? await db.agentCollaborationTask.findUnique({ where: { id } });
  if (!initial || initial.state !== 'submitted' || state.active.has(id) || state.active.size >= LIMITS.concurrent) return;
  if ([...state.active.values()].some((entry) => entry.targetId === initial.targetAgentId)) return;
  const depth = initial.ancestorTaskIds.length;
  if ([...state.active.values()].filter((entry) => entry.depth === depth).length >= LIMITS.workersPerDepth) return;
  const controller = new AbortController();
  state.active.set(id, { targetId: initial.targetAgentId, depth, controller });
  let release: (() => void) | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    release = beginWorkspaceOperation(initial.workspaceId);
    if (!release) throw new CollaborationError('workspace_closing', 'Workspace is closing.');
    const claimed = await db.agentCollaborationTask.updateMany({ where: { id, state: 'submitted', cancelRequestedAt: null },
      data: { state: 'working', startedAt: new Date(), attempt: { increment: 1 } } });
    if (!claimed.count) return;
    const task = await db.agentCollaborationTask.findUniqueOrThrow({ where: { id } });
    await validateTask(task);
    deadline = setTimeout(() => controller.abort(new CollaborationError('deadline_exceeded', 'Task deadline exceeded.')), Math.max(1, task.deadlineAt.getTime() - Date.now()));
    const ownerSignal = runtimeAbortSignal();
    const signal = ownerSignal ? AbortSignal.any([controller.signal, ownerSignal]) : controller.signal;
    const result = await withLogContext({ workspaceId: task.workspaceId, agentId: task.targetAgentId }, () => executor(task, signal));
    signal.throwIfAborted();
    if (Buffer.byteLength(result.text, 'utf8') > LIMITS.resultBytes) throw new CollaborationError('result_too_large', 'Delegation result exceeds byte limit.');
    // Recheck binding and revocation before publishing a result after a long run.
    await validateTask(task);
    await db.$transaction(async (tx) => {
      await lockRoot(tx, task.rootId);
      const current = await tx.agentCollaborationTask.findUnique({ where: { id } });
      if (!current || current.state !== 'working') return;
      if (current.cancelRequestedAt || signal.aborted) throw new CollaborationError('canceled', 'Cancellation requested.');
      if (!await tx.conversation.count({ where: { id: task.contextId, agentId: task.targetAgentId, agent: { workspaceId: task.workspaceId } } })) throw new CollaborationError('context_lost', 'Context removed.');
      await tx.message.createMany({ data: [
        { conversationId: task.contextId, role: 'user', parts: [{ type: 'text', text: task.message }], textCharacters: task.message.length },
        { conversationId: task.contextId, role: 'assistant', parts: [{ type: 'text', text: result.text }], textCharacters: result.text.length },
      ] });
      await tx.agentCollaborationTask.update({ where: { id }, data: {
        state: current.question ? 'input-required' : 'completed', result: result.text, usage: result.usage,
        completedAt: current.question ? null : new Date(), errorCode: null,
      } });
    });
  } catch (error) {
    // Do not store arbitrary native errors: they can include credentials, file
    // contents and upstream bodies. Metadata-only failure codes are intentional.
    const current = await db.agentCollaborationTask.findUnique({ where: { id } }).catch(() => null);
    if (current && !terminal(current.state)) {
      const canceled = Boolean(current.cancelRequestedAt) || (controller.signal.aborted && (!(controller.signal.reason instanceof CollaborationError) || controller.signal.reason.code === 'canceled'))
        || (error instanceof CollaborationError && error.code === 'canceled');
      const code = current.cancelRequestedAt ? 'canceled'
        : controller.signal.reason instanceof CollaborationError ? controller.signal.reason.code
        : error instanceof CollaborationError ? error.code : 'execution_failed';
      await db.$transaction(async (tx) => {
        await lockRoot(tx, current.rootId, false);
        await tx.agentCollaborationTask.updateMany({ where: { id, state: { in: ['working', 'submitted'] } }, data: {
          state: canceled ? 'canceled' : 'failed', errorCode: code, completedAt: new Date(),
        } });
        const descendants = await tx.agentCollaborationTask.findMany({ where: { parentTaskId: id } });
        for (const child of descendants) await cancelTree(tx, child);
      });
    }
  } finally {
    if (deadline) clearTimeout(deadline);
    release?.(); state.active.delete(id);
  }
}

// Seven-day database retention. Only private task contexts are removed; caller
// conversations and sandbox/native files retain their existing lifecycle.
export async function pruneCollaborationHistory(now = new Date()) {
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const roots = await db.agentCollaborationRun.findMany({ where: { parentTaskId: null,
    closedAt: { lt: cutoff }, deadlineAt: { lt: cutoff } }, orderBy: { createdAt: 'asc' }, take: 50 });
  for (const root of roots) {
    await db.$transaction(async (tx) => {
      await lockRoot(tx, root.id);
      if (await tx.agentCollaborationRun.count({ where: { rootId: root.id, closedAt: null } })
        || await tx.agentCollaborationTask.count({ where: { rootId: root.id,
          state: { in: ['submitted', 'working', 'input-required', 'auth-required'] } } })) return;
      const contexts = await tx.agentCollaborationTask.findMany({ where: { rootId: root.id }, select: { contextId: true, targetAgentId: true } });
      await tx.agentCollaborationRun.deleteMany({ where: { rootId: root.id } });
      for (const context of contexts) await tx.conversation.deleteMany({ where: { id: context.contextId,
        agentId: context.targetAgentId, agent: { workspaceId: root.workspaceId }, workSession: null, publicApiConversation: null } });
    });
  }
}

export async function tickCollaboration() {
  if (state.ticking || state.stopping || !runtimeCanOperate()) return;
  state.ticking = true;
  try {
    const now = new Date();
    if (now.getTime() - state.prunedAt > 60 * 60_000) {
      await pruneCollaborationHistory(now); state.prunedAt = now.getTime();
    }
    const activeIds = [...state.active.keys()];
    if (activeIds.length) {
      const rows = await db.agentCollaborationTask.findMany({ where: { id: { in: activeIds } } });
      for (const [id, entry] of state.active) {
        const row = rows.find((task) => task.id === id);
        if (!row || row.cancelRequestedAt || row.deadlineAt <= now) entry.controller.abort(new CollaborationError(
          row?.deadlineAt && row.deadlineAt <= now ? 'deadline_exceeded' : 'canceled', 'Task no longer active.'));
        else {
          try { await validateTask(row); } catch (error) { entry.controller.abort(error); }
        }
      }
    }
    await db.agentCollaborationTask.updateMany({ where: { state: { in: ['submitted', 'input-required', 'auth-required'] }, deadlineAt: { lte: now } },
      data: { state: 'failed', errorCode: 'deadline_exceeded', completedAt: now } });
    if (state.active.size < LIMITS.concurrent) {
      // Prefer deeper work and reserve capacity per depth: waiting parent
      // turns must not consume every slot required by their child tasks.
      const queued = await db.$queryRaw<AgentCollaborationTask[]>`SELECT * FROM "AgentCollaborationTask"
        WHERE state='submitted' AND "cancelRequestedAt" IS NULL
        ORDER BY cardinality("ancestorTaskIds") DESC, "createdAt" ASC LIMIT 64`;
      for (const task of queued) {
        if (state.active.size >= LIMITS.concurrent) break;
        if ([...state.active.values()].some((entry) => entry.targetId === task.targetAgentId)) continue;
        // Schedule admission synchronously before the first asynchronous claim.
        const promise = processCollaborationTask(task.id, executeCollaborationTask, task);
        void promise.catch(() => systemLog('error', 'Collaboration worker could not settle a task.'));
      }
    }
  } finally { state.ticking = false; }
}
export async function startCollaborationCoordinator() {
  if (!state.reconciled) {
    // The runtime owner already recovered external processes. Never replay a
    // working task after restart: it may already have performed side effects.
    await db.agentCollaborationTask.updateMany({ where: { state: 'working' },
      data: { state: 'failed', errorCode: 'interrupted', completedAt: new Date() } });
    await db.agentCollaborationRun.updateMany({ where: { closedAt: null }, data: { closedAt: new Date() } });
    state.reconciled = true;
  }
  state.stopping = false;
  if (!state.timer) {
    state.timer = setInterval(() => { void trackRuntimeOperation(tickCollaboration).catch(() => undefined); }, 1000);
    state.timer.unref?.();
  }
}
export function stopCollaborationCoordinator() {
  state.stopping = true;
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  for (const entry of state.active.values()) entry.controller.abort(new Error('Runtime owner stopped.'));
}
