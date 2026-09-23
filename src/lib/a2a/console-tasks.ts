import 'server-only';
import { Task } from '@a2a-js/sdk';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { createLocalRootGrant, LOCAL_LIMITS, localTarget } from './local-policy';
import { isLocalGrant, type TaskGrant } from './principal';
import { getTaskRow } from './store';
import { historyView, jsonTask } from './model';
import type { ConsoleActor } from './console-service';

/** Console-only projection. Phase/ancestry are UI metadata, not new A2A wire fields. */
export type ConsoleTaskTree = {
  rootTaskId: string;
  restricted: boolean;
  nodes: Array<{ id: string; parentTaskId: string | null; agentId: string; name: string;
    state: string; phase: string; cancelRequested: boolean; resumeCount: number; updatedAt: string }>;
  selectedTask: Record<string, unknown>;
};

/** Knowing a child ID never authorizes it: enter through an owned, non-delegated root. */
export async function getConsoleTaskTree(ctx: ConsoleActor, rootId: string, selectedId = rootId): Promise<ConsoleTaskTree> {
  const authority = await createLocalRootGrant(ctx.workspaceId, ctx.agentId, ctx.actorId);
  const root = await getTaskRow(authority, rootId);
  if (root.parentTaskId || root.rootTaskId !== root.id) throw new TaskNotFoundError();
  const rows = await db.a2ATask.findMany({ where: {
    rootTaskId: root.id, context: { targetKind: 'local', workspaceId: ctx.workspaceId, expiresAt: { gt: new Date() } },
  }, orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: LOCAL_LIMITS.tasksPerRoot + 1 });
  if (rows.length > LOCAL_LIMITS.tasksPerRoot) throw new UnsupportedOperationError('Task tree exceeds its configured limit.');
  const visible = new Map<string, typeof rows[number]>();
  const targets = new Map<string, Awaited<ReturnType<typeof localTarget>>>();
  const nodes: ConsoleTaskTree['nodes'] = [];
  for (const row of rows) {
    const grant = row.grant as unknown as TaskGrant;
    if (!isLocalGrant(grant) || grant.actorId !== ctx.actorId || grant.workspaceId !== ctx.workspaceId) continue;
    if (row.id === root.id) {
      if (grant.agentId !== ctx.agentId || grant.ancestorTaskIds.length) continue;
    } else {
      const parent = row.parentTaskId ? visible.get(row.parentTaskId) : undefined;
      if (!parent || grant.rootTaskId !== root.id || grant.parentTaskId !== parent.id
        || grant.ancestorTaskIds[0] !== root.id || grant.ancestorTaskIds.at(-1) !== parent.id
        || grant.ancestorTaskIds.length !== row.depth) continue;
      const parentGrant = parent.grant as unknown as TaskGrant;
      if (!isLocalGrant(parentGrant)) continue;
      const parentTarget = targets.get(parentGrant.agentId);
      if (!parentTarget?.targets.includes(grant.agentId)) continue;
      if (grant.ancestorTaskIds.some((id, i) => {
        const ancestor = visible.get(id)?.grant as unknown as TaskGrant | undefined;
        return !ancestor || !isLocalGrant(ancestor) || ancestor.agentId !== grant.ancestorAgentIds[i];
      })) continue;
    }
    let target = targets.get(grant.agentId);
    if (!target) {
      try { target = await localTarget(db, ctx.workspaceId, grant.agentId); targets.set(grant.agentId, target); }
      catch { continue; }
    }
    // Historical execution expiry is not a read credential. Current actor/edge/config still governs access.
    if (target.binding !== grant.targetBinding) continue;
    visible.set(row.id, row);
    const task = Task.fromJSON(row.snapshot);
    const status = jsonTask(task).status as { state?: string } | undefined;
    nodes.push({ id: row.id, parentTaskId: row.parentTaskId, agentId: grant.agentId, name: target.name,
      state: status?.state ?? 'TASK_STATE_UNSPECIFIED', phase: row.phase,
      cancelRequested: Boolean(row.cancelRequestedAt), resumeCount: row.resumeCount, updatedAt: row.statusAt.toISOString() });
  }
  if (!visible.has(root.id) || !visible.has(selectedId)) throw new TaskNotFoundError();
  return { rootTaskId: root.id, nodes, restricted: visible.size !== rows.length,
    selectedTask: jsonTask(historyView(Task.fromJSON(visible.get(selectedId)!.snapshot), 0)) };
}
