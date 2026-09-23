import 'server-only';
import { createHash } from 'node:crypto';
import { Task, type Artifact, TaskState } from '@a2a-js/sdk';
import type { A2ATask } from '@prisma/client';
import { db } from '@/lib/db';
import { ensureAgentEndpointRuntime } from '@/lib/agents/public-api/runtime';
import { acquireHermesRuntimeWriteLease } from '@/lib/agents/hermes/runtime';
import { runHermesTextStream } from '@/lib/agents/hermes/client';
import { A2A_LIMITS, textArtifact } from './model';
import { assertLiveGrant, isLocalGrant, isRemoteGrant, type A2AGrant, type TaskGrant } from './principal';

export type ExecutionResult = { state: TaskState; message?: string; artifact?: Artifact; deferred?: true };
export type TaskExecutor = (task: A2ATask, signal: AbortSignal) => Promise<ExecutionResult>;
/**
 * Runtime port only: no AgentRun, Responses API, old conversations or delegation runner.
 * Reuses the audited clean-runtime materializer, not its legacy execution lifecycle.
 */
export const executePublishedTask: TaskExecutor = async (row, signal) => {
  if (isLocalGrant(row.grant as unknown as TaskGrant) || isRemoteGrant(row.grant as unknown as TaskGrant)) throw new Error('Published executor requires a published target.');
  const grant = row.grant as unknown as A2AGrant;
  await assertLiveGrant(grant, 'send'); signal.throwIfAborted();
  const context = await db.a2AContext.findFirstOrThrow({ where: { id: row.contextId,
    targetKind: 'published', ownerKey: grant.ownerKey, endpointId: grant.endpointId, clientId: grant.clientId } });
  if (!context.endpointId || !context.revisionId || !context.clientId) throw new Error('Invalid published context.');
  const runtimeKey = createHash('sha256').update(`toolplane:a2a:context:${context.id}`).digest('hex');
  const ready = await ensureAgentEndpointRuntime({ endpointId: context.endpointId!,
    revisionId: context.revisionId!, subjectHash: runtimeKey, signal });
  signal.throwIfAborted();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AgentEndpointRuntime" WHERE id=${ready.allocation.id} FOR UPDATE`;
    const live = await tx.agentEndpointRuntime.findFirst({ where: { id: ready.allocation.id,
      status: 'ready', endpointId: context.endpointId!, revisionId: context.revisionId! } });
    if (!live) throw new Error('A2A runtime allocation changed.');
    if (context.runtimeAllocationId && context.runtimeAllocationId !== live.id) throw new Error('A2A context runtime changed.');
    await tx.a2AContext.update({ where: { id: context.id }, data: { runtimeAllocationId: live.id } });
  });
  const lease = acquireHermesRuntimeWriteLease(grant.workspaceId, ready.agent.id);
  if (!lease) throw new Error('A2A runtime is busy.');
  try {
    const task = Task.fromJSON(row.snapshot);
    const text = await runHermesTextStream({ agent: ready.agent,
      messages: task.history.map((message) => ({ id: message.messageId,
        role: message.role === 1 ? 'user' as const : 'assistant' as const,
        parts: message.parts.flatMap((part) => part.content?.$case === 'text' ? [{ type: 'text' as const, text: part.content.value }] : []),
      })), sessionId: context.id, sessionKey: `a2a:${context.id}`, signal,
      timeoutMs: Math.max(1, row.deadlineAt.getTime() - Date.now()), writeLease: lease,
      maxOutputCharacters: A2A_LIMITS.outputCharacters, onDelta: () => undefined,
    });
    signal.throwIfAborted(); await assertLiveGrant(grant, 'send');
    return { state: TaskState.TASK_STATE_COMPLETED, artifact: textArtifact(text) };
  } finally { lease.release(); }
};

/** Target dispatch belongs to the native task core, never the legacy Responses lifecycle. */
export const executeTask: TaskExecutor = async (row, signal) => {
  if (isRemoteGrant(row.grant as unknown as TaskGrant)) {
    const { executeRemoteTask } = await import('./remote-executor');
    return executeRemoteTask(row, signal);
  }
  const { isLocalGrant } = await import('./principal');
  if (isLocalGrant(row.grant as unknown as import('./principal').TaskGrant)) {
    const { executeLocalTask } = await import('./local-executor');
    return executeLocalTask(row, signal);
  }
  return executePublishedTask(row, signal);
};
