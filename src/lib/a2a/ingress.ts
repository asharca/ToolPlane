import 'server-only';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { z } from 'zod';
import { COMMAND_RESULT_PART, RUNTIME_COMMANDS_PART, RUNTIME_USAGE_PART, RuntimeCommandSchema, RuntimeCommandsSchema } from '@/lib/agents/runtime-commands';
import type { RuntimeCommand, RuntimeCommandResult, RuntimeUsage } from '@/lib/agents/runtime-commands';
import { db } from '@/lib/db';
import { assertRuntimeOwner } from '@/lib/runtime/ownership-state';
import { recordA2AEvent, a2aTaskOutcome, taskStateName } from '@/lib/observability/a2a-log';
import { createLocalEntryGrant, assertLocalGrant, localOwnerKey } from './local-policy';
import { createEntryPolicy, type EntryIdentity } from './entry-policy';
import { submitTaskInTransaction, getTaskRow, requestCancellation, taskScope } from './store';
import { settled, terminal, A2A_LIMITS, historyView, jsonTask } from './model';
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
  const started = performance.now();
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
  const { row, grant } = accepted;
  await recordA2AEvent({ eventName: 'a2a.request',
    binding: { grant, taskId: row.id, contextId: row.contextId,
      rootTaskId: row.rootTaskId ?? row.id, parentTaskId: row.parentTaskId ?? undefined },
    metadata: { direction: 'inbound', transport: 'entry', entryKind: input.kind, taskState: taskStateName(TaskState[row.state]) },
    rpcMethod: 'SendMessage', outcome: a2aTaskOutcome(TaskState[row.state]), durationMs: performance.now() - started,
    request: () => SendMessageRequest.toJSON(SendMessageRequest.fromJSON({ message: {
      messageId: `entry-${hash([input.kind, input.sourceId, input.messageId])}`,
      role: 'ROLE_USER', parts: [{ text: input.text }],
    }, configuration: { returnImmediately: true } })),
    response: () => ({ task: jsonTask(historyView(Task.fromJSON(row.snapshot), 0)) }),
    responseKind: 'json', responseComplete: true,
  });
  wake();
  return accepted;
}
/** Legacy responses are presentation projections; disconnect detaches the observer only. */
export async function runNativeEntry(input: NativeEntryInput & { signal?: AbortSignal;
  onAccepted?: (task: Task, path: string) => void | Promise<void> }) {
  const accepted = await submitNativeEntry(input);
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: input.workspaceId }, select: { slug: true } });
  const path = `/app/${encodeURIComponent(workspace.slug)}/agents/${encodeURIComponent(input.agentId)}?settings=a2a&task=${encodeURIComponent(accepted.row.id)}`;
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

export type NativeEntryRuntimePart =
  | { type: typeof RUNTIME_COMMANDS_PART; data: { runtimeKind: 'pi-sdk'; commands: RuntimeCommand[] } }
  | { type: typeof RUNTIME_USAGE_PART; data: RuntimeUsage }
  | { type: typeof COMMAND_RESULT_PART; data: RuntimeCommandResult };
const piSdkMetadataSchema = z.object({
  commands: RuntimeCommandsSchema,
  usage: z.object({ inputTokens: z.number().finite().nonnegative(), outputTokens: z.number().finite().nonnegative(),
    cacheReadTokens: z.number().finite().nonnegative(), cacheWriteTokens: z.number().finite().nonnegative(),
    costUsd: z.number().finite().nonnegative().optional() }).strict().optional(),
  commandResult: z.object({ command: RuntimeCommandSchema.shape.name, text: z.string().max(A2A_LIMITS.outputCharacters),
    status: z.enum(['completed', 'failed']) }).strict().optional(),
}).strict();
/** Project only the public runtime metadata, never SDK state or private paths. */
export function nativeEntryRuntimeParts(task: Task): NativeEntryRuntimePart[] {
  if (task.status?.state !== TaskState.TASK_STATE_COMPLETED) return [];
  for (let index = task.artifacts.length - 1; index >= 0; index--) {
    const artifact = task.artifacts[index];
    if (!artifact.parts.some((part) => part.content?.$case === 'text')) continue;
    const parsed = piSdkMetadataSchema.safeParse(artifact.metadata?.toolplanePiSdk);
    if (!parsed.success) continue;
    const { commands, usage, commandResult } = parsed.data;
    const parts: NativeEntryRuntimePart[] = [{ type: RUNTIME_COMMANDS_PART, data: { runtimeKind: 'pi-sdk', commands } }];
    if (usage) parts.push({ type: RUNTIME_USAGE_PART, data: usage });
    if (commandResult) parts.push({ type: COMMAND_RESULT_PART, data: commandResult });
    return parts;
  }
  return [];
}
