import 'server-only';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { assertRuntimeOwner } from '@/lib/runtime/ownership-state';
import { createLocalEntryGrant, assertLocalGrant, localOwnerKey } from './local-policy';
import { createEntryPolicy, type EntryIdentity } from './entry-policy';
import { submitTaskInTransaction, getTaskRow, requestCancellation, taskScope } from './store';
import { settled, terminal, A2A_LIMITS } from './model';
import { refreshTaskStorage } from './quotas';
import { wakeA2AWorker } from './worker';

export type EntryMessage = { id?: string; role: string; parts: unknown };
export type NativeEntryInput = EntryIdentity & {
  workspaceId: string; agentId: string; actorId: string; messageId: string; text: string;
};
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
/** Only the latest explicit text becomes new work. Old tool calls are never replayed. */
export function latestEntryText(message: EntryMessage | undefined): string {
  if (!message || message.role !== 'user' || !Array.isArray(message.parts)) throw new RequestMalformedError('A user message is required.');
  const parts = message.parts as Array<{ type?: string; text?: unknown }>;
  if (!parts.length || parts.some((part) => !part || part.type !== 'text' || typeof part.text !== 'string')) {
    throw new UnsupportedOperationError('Native ingress currently accepts text only; attachments must be handled explicitly, not silently discarded.');
  }
  const text = parts.map((p) => p.text).join('\n').trim();
  if (!text || text.length > A2A_LIMITS.inputCharacters) throw new RequestMalformedError('The native task input is empty or too large.');
  return text;
}
export async function submitNativeEntry(input: NativeEntryInput, wake: () => void = wakeA2AWorker) {
  assertRuntimeOwner();
  if (!input.actorId || !input.sourceId || input.sourceId.length > 200 || !input.messageId || input.messageId.length > 240
    || !input.text.trim() || input.text.length > A2A_LIMITS.inputCharacters) throw new RequestMalformedError('Invalid native entry request.');
  const accepted = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${input.workspaceId} FOR UPDATE`;
    const scope = { workspaceId: input.workspaceId, agentId: input.agentId, actorId: input.actorId };
    const policy = await createEntryPolicy(tx, scope, { kind: input.kind, sourceId: input.sourceId, ...(input.channelId ? { channelId: input.channelId } : {}) });
    const grant = await createLocalEntryGrant(tx, input.workspaceId, input.agentId, input.actorId, policy);
    await assertLocalGrant(grant, tx);
    const key = { ownerKey: grant.ownerKey, kind: input.kind, sourceId: input.sourceId };
    const inputHash = hash([input.text]);
    let binding = await tx.a2AEntryBinding.findUnique({ where: { ownerKey_kind_sourceId: key }, include: { lastTask: true } });
    if (!binding) {
      const previousKey = { ...key, ownerKey: localOwnerKey(input.workspaceId, input.agentId, input.actorId) };
      const legacy = await tx.a2AEntryBinding.findUnique({ where: { ownerKey_kind_sourceId: previousKey } });
      if (legacy) {
        const receipt = await tx.a2AEntryReceipt.findUnique({ where: { bindingId_messageId: { bindingId: legacy.id, messageId: input.messageId } }, include: { task: true } });
        if (receipt) {
          if (receipt.inputHash !== inputHash) throw new RequestMalformedError('The entry message ID was reused with different content.');
          const previous = receipt.task.grant as unknown as typeof grant;
          if (!previous.entryPolicy || previous.entryPolicy.kind !== policy.kind || previous.entryPolicy.sourceId !== policy.sourceId
            || previous.entryPolicy.binding !== policy.binding || previous.agentId !== grant.agentId
            || previous.actorId !== grant.actorId || previous.ownerKey !== previousKey.ownerKey) throw new TaskNotFoundError();
          await assertLocalGrant(previous, tx);
          if (!await tx.a2AContext.count({ where: { id: receipt.task.contextId, ...taskScope(previous), expiresAt: { gt: new Date() } } })) throw new TaskNotFoundError();
          return { row: receipt.task, grant: previous, replay: true };
        }
      }
    }
    const replay = binding ? await tx.a2AEntryReceipt.findUnique({ where: { bindingId_messageId: { bindingId: binding.id, messageId: input.messageId } }, include: { task: true } }) : null;
    if (replay) {
      if (replay.inputHash !== inputHash) throw new RequestMalformedError('The entry message ID was reused with different content.');
      if (!await tx.a2AContext.count({ where: { id: replay.task.contextId, ownerKey: grant.ownerKey, expiresAt: { gt: new Date() } } })) throw new TaskNotFoundError();
      return { row: replay.task, grant, replay: true };
    }
    const previous = binding?.lastTask;
    if (previous && !settled(previous.state)) throw new UnsupportedOperationError('The previous native task is still active. Query or explicitly cancel it.');
    if (previous?.state === TaskState.TASK_STATE_AUTH_REQUIRED) throw new UnsupportedOperationError('A message cannot approve an authorization request.');
    // No copied model/system/tool history: a first migrated conversation starts a new native context.
    // Existing records remain readable. Subsequent turns reuse the native context only.
    const request = SendMessageRequest.fromJSON({ message: { messageId: `entry-${hash([input.kind, input.sourceId, input.messageId])}`,
      role: 'ROLE_USER', parts: [{ text: input.text }],
      ...(previous ? { contextId: previous.contextId,
        ...(previous.state === TaskState.TASK_STATE_INPUT_REQUIRED ? { taskId: previous.id } : { referenceTaskIds: [previous.id] }) } : {}) },
      configuration: { returnImmediately: true } });
    const row = await submitTaskInTransaction(tx, grant, request);
    binding = await tx.a2AEntryBinding.upsert({ where: { ownerKey_kind_sourceId: key },
      create: { ...key, contextId: row.contextId, lastTaskId: row.id }, update: { lastTaskId: row.id }, include: { lastTask: true } });
    await tx.a2AEntryReceipt.create({ data: { bindingId: binding.id, messageId: input.messageId, inputHash, taskId: row.id } });
    await refreshTaskStorage(tx, row.id);
    return { row, grant, replay: false };
  });
  wake();
  return accepted;
}
/** Legacy responses are presentation projections; disconnect detaches the observer only. */
export async function runNativeEntry(input: NativeEntryInput & { signal?: AbortSignal;
  onAccepted?: (task: Task, path: string) => void | Promise<void> }) {
  const accepted = await submitNativeEntry(input);
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: input.workspaceId }, select: { slug: true } });
  const path = `/app/${encodeURIComponent(workspace.slug)}/work?mode=a2a&agent=${encodeURIComponent(input.agentId)}&task=${encodeURIComponent(accepted.row.id)}${accepted.grant.entryPolicy ? '&view=entry' : ''}`;
  await input.onAccepted?.(Task.fromJSON(accepted.row.snapshot), path);
  try {
    while (true) {
      input.signal?.throwIfAborted();
      await assertLocalGrant(accepted.grant);
      const row = await getTaskRow(accepted.grant, accepted.row.id);
      if (settled(row.state)) return { task: Task.fromJSON(row.snapshot), path };
      if (row.deadlineAt <= new Date()) throw new UnsupportedOperationError(`Task deadline reached. Inspect the durable task at ${path}`);
      await delay(500, undefined, { signal: input.signal });
    }
  } catch (error) {
    // Work's explicit cancel flag is authoritative. A socket close/shutdown is not.
    if (input.kind === 'work') {
      const work = await db.workSession.findFirst({ where: { id: input.sourceId, workspaceId: input.workspaceId,
        agentId: input.agentId, a2aActorId: input.actorId }, select: { cancelRequestedAt: true } });
      const row = await db.a2ATask.findUnique({ where: { id: accepted.row.id } });
      if (work?.cancelRequestedAt && row && !terminal(row.state)) await requestCancellation(accepted.grant, row.id);
    }
    throw error;
  }
}
export function nativeEntryResult(task: Task, path: string) {
  const text = task.artifacts.flatMap((a) => a.parts.flatMap((p) => p.content?.$case === 'text' ? [p.content.value] : [])).join('\n\n');
  const detail = task.status?.message?.parts.flatMap((p) => p.content?.$case === 'text' ? [p.content.value] : []).join('\n');
  if (task.status?.state === TaskState.TASK_STATE_COMPLETED) return text || `Task completed. Results: ${path}`;
  if (task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) return detail || `More input is required: ${path}`;
  // Never let an error/cancelled task look like a successful legacy response.
  throw new UnsupportedOperationError(`Native task did not complete (${task.status?.state ?? 'unknown'}). Inspect ${path}`);
}
