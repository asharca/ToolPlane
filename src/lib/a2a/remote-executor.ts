import 'server-only';
import { createHash } from 'node:crypto';
import { AgentCard, Message, SendMessageRequest, GetTaskRequest, CancelTaskRequest, Task, TaskState, type SendMessageResult } from '@a2a-js/sdk';
import { db } from '@/lib/db';
import { runtimeCanOperate, runtimeAbortSignal, trackRuntimeOperation } from '@/lib/runtime/ownership-state';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { withLogContext } from '@/lib/observability/context';
import { createRemoteClient, remoteResult, textArtifact } from './remote-client';
import { remoteCredential } from './remote-registry';
import { assertRemoteGrant } from './remote-policy';
import { isRemoteGrant, type RemoteA2AGrant, type TaskGrant } from './principal';
import { RemoteA2AError } from './remote-network';
import { lockTask, persist, transition, interruptTask } from './store';
import { terminal, taskEvent } from './model';
import type { TaskExecutor } from './executor';

async function clientFor(grant: RemoteA2AGrant, cancellation = false) {
  await assertRemoteGrant(grant, db, cancellation);
  const remote = await db.remoteA2AAgent.findFirstOrThrow({ where: { id: grant.remoteAgentId, workspaceId: grant.workspaceId } });
  // Check again after loading: a concurrent reconfiguration must not send a previous task to a new identity.
  await assertRemoteGrant(grant, db, cancellation);
  const binding = createHash('sha256').update(JSON.stringify([remote.id, remote.workspaceId, remote.revision, remote.cardUrl, remote.rpcUrl])).digest('hex');
  if (binding !== grant.targetBinding) throw new RemoteA2AError();
  return createRemoteClient(AgentCard.fromJSON(remote.card), remote.rpcUrl, remoteCredential(remote));
}
async function recordObservation(id: string, result: SendMessageResult, expectedLease?: string, expectedMessageId?: string) {
  const observation = remoteResult(result);
  return db.$transaction(async (tx) => {
    const row = await lockTask(tx, id);
    if (terminal(row.state) || expectedLease && row.leaseToken !== expectedLease
      || !expectedLease && (row.phase !== 'remote-waiting' || row.remoteMessageId !== expectedMessageId)) return;
    const grant = row.grant as unknown as TaskGrant;
    if (!isRemoteGrant(grant)) throw new RemoteA2AError();
    await assertRemoteGrant(grant, tx, Boolean(row.cancelRequestedAt));
    if (row.deadlineAt <= new Date()) throw new RemoteA2AError();
    if (row.remoteTaskId && row.remoteTaskId !== observation.taskId || row.remoteContextId && row.remoteContextId !== observation.contextId) throw new RemoteA2AError('Remote task binding changed.');
    const task = Task.fromJSON(row.snapshot);
    const state = observation.state === TaskState.TASK_STATE_SUBMITTED ? TaskState.TASK_STATE_WORKING : observation.state;
    if (!terminal(state) && !observation.taskId) throw new RemoteA2AError();
    // A cancellation request never fabricates confirmation. The remote's completed/failed/canceled result wins.
    const detail = observation.detail || undefined;
    const nextPhase = terminal(state) ? 'done' : 'remote-waiting';
    const changed = task.status?.state !== state || task.status?.message?.parts.map((part) => part.content?.value).join('\n') !== detail;
    if (task.status?.state !== state) {
      // A peer may resume externally resolved input/auth without a local model round.
      if ([6, 8].includes(task.status!.state) && state === TaskState.TASK_STATE_WORKING) transition(task, TaskState.TASK_STATE_SUBMITTED);
      transition(task, state, detail);
    }
    else if (changed) {
      task.status = { ...task.status, state, timestamp: new Date().toISOString(),
        message: detail ? Message.fromJSON({ messageId: crypto.randomUUID(), taskId: id, contextId: row.contextId, role: 'ROLE_AGENT', parts: [{ text: detail }] }) : undefined };
    }
    if (state === TaskState.TASK_STATE_COMPLETED && observation.text) {
      task.artifacts.push(textArtifact(observation.text));
    }
    const fields = { remoteTaskId: observation.taskId, remoteContextId: observation.contextId,
      remotePollAt: new Date(Date.now() + 2000), remotePollFailures: 0, leaseToken: null, phase: nextPhase };
    if (changed || terminal(state) || expectedLease) await persist(tx, row, task, taskEvent(task), fields);
    else await tx.a2ATask.update({ where: { id }, data: fields });
  });
}
/** Submit exactly once per accepted local message. Subsequent work uses GetTask, not SendMessage retries. */
export const executeRemoteTask: TaskExecutor = async (row, signal) => {
  const grant = row.grant as unknown as TaskGrant;
  if (!isRemoteGrant(grant) || !row.leaseToken) throw new RemoteA2AError();
  const client = await clientFor(grant);
  const input = SendMessageRequest.fromJSON(row.request);
  const message = input.message!;
  const outboundId = createHash('sha256').update(JSON.stringify(['a2a-remote-message', grant.ownerKey, message.messageId])).digest('hex');
  await db.$transaction(async (tx) => {
    const current = await lockTask(tx, row.id); await assertRemoteGrant(grant, tx);
    if (current.leaseToken !== row.leaseToken || current.cancelRequestedAt || current.deadlineAt <= new Date()
      || current.remoteMessageId === outboundId) throw new RemoteA2AError();
    await tx.a2ATask.update({ where: { id: row.id }, data: { remoteMessageId: outboundId,
      remoteDispatchedAt: new Date(), remoteCancelSentAt: null } });
  });
  signal.throwIfAborted();
  // Local identity, tenant, authority metadata and unrelated task references are never forwarded.
  const request = SendMessageRequest.fromJSON({ message: { messageId: outboundId, role: 'ROLE_USER',
    parts: message.parts.map((part) => ({ text: part.content?.value })),
    ...(row.remoteTaskId ? { taskId: row.remoteTaskId, contextId: row.remoteContextId } : {}) },
    configuration: { returnImmediately: true, historyLength: 0, acceptedOutputModes: ['text/plain'] } });
  const result = await client.sendMessage(request, { signal });
  await recordObservation(row.id, result, row.leaseToken);
  return { state: TaskState.TASK_STATE_WORKING, deferred: true };
};
let polling = false;
/** Separate bounded observer loop: remote waiting does not occupy a native model execution slot. */
export async function reconcileRemoteTasks() {
  if (polling || !runtimeCanOperate()) return;
  polling = true;
  try {
    const rows = await db.a2ATask.findMany({ where: { phase: 'remote-waiting', state: { in: [2, 6, 8] },
      OR: [{ remotePollAt: null }, { remotePollAt: { lte: new Date() } }] }, orderBy: { remotePollAt: 'asc' }, take: 4 });
    await Promise.all(rows.map((row) => trackRuntimeOperation(() => withLogContext({ suppressPayload: true }, async () => {
      const grant = row.grant as unknown as TaskGrant;
      if (!isRemoteGrant(grant)) return;
      const release = beginWorkspaceOperation(grant.workspaceId);
      try {
        if (!release || !row.remoteTaskId || row.deadlineAt <= new Date()) throw new RemoteA2AError();
        const client = await clientFor(grant, Boolean(row.cancelRequestedAt));
        const ownerSignal = runtimeAbortSignal();
        const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(15_000, row.deadlineAt.getTime() - Date.now()))), ...(ownerSignal ? [ownerSignal] : [])]);
        const current = await db.a2ATask.findUniqueOrThrow({ where: { id: row.id } });
        if (current.phase !== 'remote-waiting' || terminal(current.state) || current.remoteMessageId !== row.remoteMessageId) return;
        let result: Task;
        if (current.cancelRequestedAt && !current.remoteCancelSentAt) {
          await assertRemoteGrant(grant, db, true);
          const marked = await db.a2ATask.updateMany({ where: { id: row.id, remoteCancelSentAt: null, phase: 'remote-waiting', remoteMessageId: row.remoteMessageId }, data: { remoteCancelSentAt: new Date() } });
          if (!marked.count) return;
          try { result = await client.cancelTask(CancelTaskRequest.fromJSON({ id: row.remoteTaskId }), { signal }); }
          catch { result = await client.getTask(GetTaskRequest.fromJSON({ id: row.remoteTaskId, historyLength: 0 }), { signal }); }
        } else result = await client.getTask(GetTaskRequest.fromJSON({ id: row.remoteTaskId, historyLength: 0 }), { signal });
        await recordObservation(row.id, result, undefined, row.remoteMessageId ?? undefined);
      } catch {
        // Only failed reads get bounded retries. Never retry a business submission or unconfirmed cancellation.
        let live = true;
        try { await assertRemoteGrant(grant, db, Boolean(row.cancelRequestedAt)); } catch { live = false; }
        if (!live || !row.remoteTaskId || row.remotePollFailures >= 4 || row.deadlineAt <= new Date()) {
          await interruptTask(row.id, 'Remote observation stopped.', { remoteMessageId: row.remoteMessageId, phase: 'remote-waiting' });
        } else await db.a2ATask.updateMany({ where: { id: row.id, phase: 'remote-waiting', remoteMessageId: row.remoteMessageId }, data: {
          remotePollFailures: { increment: 1 }, remotePollAt: new Date(Date.now() + Math.min(16_000, 2000 * 2 ** row.remotePollFailures)) } });
      } finally { release?.(); }
    }))));
  } finally { polling = false; }
}
