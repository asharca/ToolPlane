import 'server-only';
import { createHash } from 'node:crypto';
import { TaskState } from '@a2a-js/sdk';
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { assertLocalActor, assertLocalGrant, LOCAL_LIMITS, localOwnerKey, localTarget } from './local-policy';
import { A2A_SCOPES, isLocalGrant, type TaskGrant, type RemoteA2AGrant } from './principal';
import { remotePair } from './remote-network';
const missing = () => new TaskNotFoundError();
export async function remoteTarget(tx: Prisma.TransactionClient, workspaceId: string, sourceAgentId: string, id: string) {
  const row = await tx.remoteA2AAgent.findFirst({ where: { id, workspaceId, enabled: true, allowedAgentIds: { has: sourceAgentId } },
    select: { id: true, workspaceId: true, name: true, cardUrl: true, rpcUrl: true, revision: true } });
  if (!row) throw missing();
  remotePair(row.cardUrl, row.rpcUrl);
  return { ...row, binding: createHash('sha256').update(JSON.stringify([row.id, row.workspaceId, row.revision, row.cardUrl, row.rpcUrl])).digest('hex') };
}
export async function assertRemoteGrant(grant: RemoteA2AGrant, tx: Prisma.TransactionClient = db, cancellation = false) {
  if (!grant.parentTaskId || !grant.rootTaskId || grant.ancestorTaskIds.length !== grant.ancestorAgentIds.length
    || !grant.ancestorTaskIds.length || grant.ancestorTaskIds.length > LOCAL_LIMITS.depth
    || grant.ancestorTaskIds.at(-1) !== grant.parentTaskId || grant.ancestorAgentIds.at(-1) !== grant.sourceAgentId
    || grant.ancestorTaskIds[0] !== grant.rootTaskId || grant.expiresAt <= Date.now()) throw missing();
  await assertLocalActor(tx, grant.workspaceId, grant.actorId);
  const target = await remoteTarget(tx, grant.workspaceId, grant.sourceAgentId, grant.remoteAgentId);
  if (target.binding !== grant.targetBinding) throw missing();
  const parent = await tx.a2ATask.findUnique({ where: { id: grant.parentTaskId } });
  const authority = parent?.grant as unknown as TaskGrant | undefined;
  if (!parent || !authority || !isLocalGrant(authority) || authority.workspaceId !== grant.workspaceId
    || authority.actorId !== grant.actorId || authority.agentId !== grant.sourceAgentId) throw missing();
  if (JSON.stringify(grant.ancestorTaskIds) !== JSON.stringify([...authority.ancestorTaskIds, parent.id])
    || JSON.stringify(grant.ancestorAgentIds) !== JSON.stringify([...authority.ancestorAgentIds, authority.agentId])
    || grant.expiresAt > Math.min(authority.expiresAt, parent.deadlineAt.getTime())) throw missing();
  if (cancellation) {
    // A stopped parent may still cancel a known remote task, but never authorize new work.
    if ((await localTarget(tx, grant.workspaceId, authority.agentId)).binding !== authority.targetBinding) throw missing();
    return;
  }
  if (parent.cancelRequestedAt || parent.deadlineAt <= new Date() || [3,4,5,7].includes(parent.state)) throw missing();
  await assertLocalGrant(authority, tx);
}
export async function remoteChildGrant(parentId: string, lease: string, remoteId: string): Promise<RemoteA2AGrant> {
  const parent = await db.a2ATask.findUnique({ where: { id: parentId } });
  const caller = parent?.grant as unknown as TaskGrant | undefined;
  if (!parent || !caller || !isLocalGrant(caller) || parent.state !== TaskState.TASK_STATE_WORKING
    || parent.phase !== 'executing' || parent.leaseToken !== lease || parent.cancelRequestedAt) throw missing();
  await assertLocalGrant(caller);
  if (caller.ancestorTaskIds.length + 1 > LOCAL_LIMITS.depth) throw new UnsupportedOperationError('Remote delegation depth limit reached.');
  const target = await remoteTarget(db, caller.workspaceId, caller.agentId, remoteId);
  return { kind: 'remote', workspaceId: caller.workspaceId, sourceAgentId: caller.agentId, remoteAgentId: remoteId,
    actorId: caller.actorId, targetBinding: target.binding,
    ownerKey: localOwnerKey('remote', caller.workspaceId, parent.id, remoteId, caller.actorId),
    parentTaskId: parent.id, rootTaskId: parent.rootTaskId ?? parent.id,
    ancestorTaskIds: [...caller.ancestorTaskIds, parent.id], ancestorAgentIds: [...caller.ancestorAgentIds, caller.agentId],
    expiresAt: Math.min(caller.expiresAt, parent.deadlineAt.getTime()), timeoutSeconds: 840, retentionDays: 7,
    maxConcurrent: 4, scopes: [...A2A_SCOPES] };
}
