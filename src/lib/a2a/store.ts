import 'server-only';
import { createHash, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type A2ATask } from '@prisma/client';
import { Artifact, Message, SendMessageRequest, StreamResponse, Task, TaskState,
  type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { runtimeEnv } from '@/lib/runtime-env';
import { ACTIVE, A2A_LIMITS, assertCancelable, assertTransition, historyView, jsonEvent, jsonTask,
  taskEvent, statusEvent, agentMessage, terminal } from './model';
import type { A2AGrant } from './principal';
import { validateSend } from './validation';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const notFound = () => new TaskNotFoundError();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
const scope = (grant: A2AGrant) => ({ ownerKey: grant.ownerKey, endpointId: grant.endpointId, clientId: grant.clientId });
export async function getTaskRow(grant: A2AGrant, id: string) {
  const row = await db.a2ATask.findFirst({ where: { id, context: { ...scope(grant), expiresAt: { gt: new Date() } } } });
  if (!row) throw notFound();
  return row;
}
export async function getTask(grant: A2AGrant, id: string, historyLength?: number) {
  return historyView(Task.fromJSON((await getTaskRow(grant, id)).snapshot), historyLength);
}
async function lockTask(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "A2ATask" WHERE id=${id} FOR UPDATE`;
  return tx.a2ATask.findUniqueOrThrow({ where: { id } });
}
async function persist(tx: Tx, row: A2ATask, task: Task, event: StreamResponse, data: Prisma.A2ATaskUpdateInput = {}) {
  if (Buffer.byteLength(JSON.stringify(jsonTask(task)), 'utf8') > A2A_LIMITS.snapshotBytes) throw new UnsupportedOperationError('Task storage limit exceeded.');
  const sequence = row.sequence + 1;
  const updated = await tx.a2ATask.update({ where: { id: row.id }, data: { ...data,
    state: task.status!.state, statusAt: new Date(task.status!.timestamp!), snapshot: json(jsonTask(task)), sequence,
    ...(terminal(task.status!.state) ? { completedAt: new Date(), leaseToken: null } : {}),
  } });
  await tx.a2AEvent.create({ data: { taskId: row.id, sequence, payload: json(jsonEvent(event)) } });
  return updated;
}
function transition(task: Task, state: TaskState, detail?: string) {
  assertTransition(task.status!.state, state);
  task.status = { state, timestamp: new Date().toISOString(),
    message: detail ? agentMessage(task, detail) : undefined };
  if (task.status.message) task.history.push(task.status.message);
}
/** Admit and queue atomically. No execution or HTTP response lifecycle in this transaction. */
export async function submitTask(grant: A2AGrant, request: SendMessageRequest) {
  validateSend(request);
  const message = request.message!;
  const contentHash = digest({ message: Message.toJSON(message), metadata: request.metadata });
  return db.$transaction(async (tx) => {
    // Serializes per-service admission including deduplication and concurrency budgets.
    await tx.$queryRaw`SELECT id FROM "AgentEndpoint" WHERE id=${grant.endpointId} FOR UPDATE`;
    const endpoint = await tx.agentEndpoint.findFirst({ where: { id: grant.endpointId,
      workspaceId: grant.workspaceId, status: 'active', a2aEnabled: true }, select: { maxConcurrent: true } });
    if (!endpoint) throw notFound();
    const replay = await tx.a2ARequest.findUnique({ where: { ownerKey_messageId: { ownerKey: grant.ownerKey, messageId: message.messageId } }, include: { task: true } });
    if (replay) {
      if (replay.contentHash !== contentHash) throw new RequestMalformedError('messageId was already used with different content.');
      if (!await tx.a2AContext.count({ where: { id: replay.task.contextId, ...scope(grant), expiresAt: { gt: new Date() } } })) throw notFound();
      return replay.task;
    }
    // Reference IDs are informational, never authorization or an instruction override.
    for (const id of message.referenceTaskIds) {
      if (!await tx.a2ATask.count({ where: { id, context: scope(grant) } })) throw notFound();
    }
    const previous = message.taskId ? await tx.a2ATask.findFirst({ where: { id: message.taskId, context: scope(grant) } }) : null;
    if (message.taskId && !previous) throw notFound();
    if (previous && message.contextId && message.contextId !== previous.contextId) throw new RequestMalformedError('taskId and contextId do not match.');
    const contextId = previous?.contextId ?? message.contextId;
    let context = contextId ? await tx.a2AContext.findFirst({ where: { id: contextId, ...scope(grant), expiresAt: { gt: new Date() } } }) : null;
    if (contextId && !context) throw notFound();
    const [endpointActive, clientActive, clientTasks, legacyEndpointActive, legacyClientActive] = await Promise.all([
      tx.a2ATask.count({ where: { state: { in: ACTIVE }, context: { endpointId: grant.endpointId } } }),
      tx.a2ATask.count({ where: { state: { in: ACTIVE }, context: { clientId: grant.clientId } } }),
      tx.a2ATask.count({ where: { context: { clientId: grant.clientId } } }),
      tx.agentRun.count({ where: { endpointId: grant.endpointId, status: { in: ['provisioning', 'running'] } } }),
      tx.agentRun.count({ where: { clientId: grant.clientId, status: { in: ['provisioning', 'running'] } } }),
    ]);
    if (endpointActive + legacyEndpointActive >= endpoint.maxConcurrent || clientActive + legacyClientActive >= grant.maxConcurrent || clientTasks >= A2A_LIMITS.tasksPerClient) throw new UnsupportedOperationError('Service task capacity reached.');
    if (context && await tx.a2ATask.count({ where: { contextId: context.id, state: { in: ACTIVE } } })) throw new UnsupportedOperationError('This context already has an executing task.');
    if (context && !previous && await tx.a2ATask.count({ where: { contextId: context.id } }) >= A2A_LIMITS.tasksPerContext) throw new UnsupportedOperationError('Context task limit reached.');
    if (!context) {
      if (await tx.a2AContext.count({ where: { clientId: grant.clientId } }) >= A2A_LIMITS.contextsPerClient) throw new UnsupportedOperationError('Client context limit reached.');
      context = await tx.a2AContext.create({ data: { id: randomUUID(), ...scope(grant), revisionId: grant.revisionId,
        expiresAt: new Date(Date.now() + Math.max(1, Math.min(grant.retentionDays, 30)) * 86_400_000) } });
    }
    const id = previous?.id ?? randomUUID();
    const accepted = Message.fromJSON({ ...Message.toJSON(message) as object, contextId: context.id, taskId: id });
    let row: A2ATask;
    if (previous) {
      row = await lockTask(tx, previous.id);
      // AUTH_REQUIRED is not a model-controlled approval channel.
      if (row.state !== TaskState.TASK_STATE_INPUT_REQUIRED || row.cancelRequestedAt || row.deadlineAt <= new Date()) throw new UnsupportedOperationError('Only a live input-required task can accept continuation input.');
      const task = Task.fromJSON(row.snapshot);
      if (task.history.length >= A2A_LIMITS.messagesPerTask) throw new UnsupportedOperationError('Task message limit reached.');
      task.history.push(accepted);
      transition(task, TaskState.TASK_STATE_SUBMITTED);
      row = await persist(tx, row, task, taskEvent(task), { request: json(SendMessageRequest.toJSON({ ...request, message: accepted })),
        grant: json({ ...grant, revisionId: context.revisionId }) });
    } else {
      const task = Task.fromJSON({ id, contextId: context.id, history: [Message.toJSON(accepted)],
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() }, metadata: request.metadata });
      const deadline = Math.min(Date.now() + Math.min(grant.timeoutSeconds, A2A_LIMITS.deadlineSeconds) * 1000,
        grant.expiresAt ?? Infinity, context.expiresAt.getTime());
      row = await tx.a2ATask.create({ data: { id, contextId: context.id, state: TaskState.TASK_STATE_SUBMITTED,
        statusAt: new Date(task.status!.timestamp!), snapshot: json(jsonTask(task)), request: json(SendMessageRequest.toJSON({ ...request, message: accepted })),
        grant: json({ ...grant, revisionId: context.revisionId }), deadlineAt: new Date(deadline),
        events: { create: { sequence: 1, payload: json(jsonEvent(taskEvent(task))) } } } });
    }
    await tx.a2ARequest.create({ data: { ownerKey: grant.ownerKey, messageId: message.messageId, contentHash, taskId: id } });
    return row;
  });
}
export async function requestCancellation(grant: A2AGrant, id: string) {
  await getTaskRow(grant, id);
  return db.$transaction(async (tx) => {
    const row = await lockTask(tx, id);
    const task = Task.fromJSON(row.snapshot);
    if (row.state === TaskState.TASK_STATE_CANCELED && row.cancelRequestedAt) return task;
    assertCancelable(task);
    if (row.state === TaskState.TASK_STATE_WORKING) {
      // A cancel request does not mean the executor has stopped. The worker settles it.
      await tx.a2ATask.update({ where: { id }, data: { cancelRequestedAt: row.cancelRequestedAt ?? new Date() } });
    } else {
      transition(task, TaskState.TASK_STATE_CANCELED);
      await persist(tx, row, task, statusEvent(task), { cancelRequestedAt: new Date() });
    }
    return task;
  });
}
export async function claimTask(id: string) {
  return db.$transaction(async (tx) => {
    const row = await lockTask(tx, id);
    if (row.state !== TaskState.TASK_STATE_SUBMITTED || row.cancelRequestedAt) return null;
    const task = Task.fromJSON(row.snapshot);
    transition(task, TaskState.TASK_STATE_WORKING);
    return persist(tx, row, task, statusEvent(task), { leaseToken: randomUUID() });
  });
}
export async function finishTask(id: string, leaseToken: string, state: TaskState, detail?: string, artifact?: Artifact) {
  return db.$transaction(async (tx) => {
    const row = await lockTask(tx, id);
    if (row.leaseToken !== leaseToken || row.state !== TaskState.TASK_STATE_WORKING) return;
    const task = Task.fromJSON(row.snapshot);
    // Cancellation/deadline wins over a racing successful executor return.
    const actual = row.cancelRequestedAt ? TaskState.TASK_STATE_CANCELED
      : row.deadlineAt <= new Date() ? TaskState.TASK_STATE_FAILED : state;
    let current = row;
    if (actual === TaskState.TASK_STATE_COMPLETED && artifact) {
      if (task.artifacts.length >= A2A_LIMITS.artifactsPerTask) throw new UnsupportedOperationError('Artifact limit reached.');
      task.artifacts.push(artifact);
      const event = StreamResponse.fromJSON({ artifactUpdate: {
        taskId: id, contextId: task.contextId, artifact: Artifact.toJSON(artifact), append: false, lastChunk: true,
      } });
      current = await persist(tx, row, task, event);
    }
    transition(task, actual, detail);
    await persist(tx, current, task, statusEvent(task), { leaseToken: null });
  });
}
export async function interruptTask(id: string, detail: string) {
  return db.$transaction(async (tx) => {
    const row = await lockTask(tx, id);
    if (terminal(row.state)) return;
    const task = Task.fromJSON(row.snapshot);
    transition(task, row.cancelRequestedAt ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED, detail);
    await persist(tx, row, task, statusEvent(task), { leaseToken: null });
  });
}
function pageSignature(value: string) {
  const secret = runtimeEnv('AUTH_SECRET'); if (!secret) throw new Error('Missing cursor signing key');
  return createHmac('sha256', secret).update('a2a-page\0').update(value).digest('hex');
}
export async function listTasks(grant: A2AGrant, params: ListTasksRequest): Promise<ListTasksResponse> {
  const pageSize = params.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RequestMalformedError('Invalid pageSize.');
  const filter = digest([grant.ownerKey, params.contextId, params.status, params.statusTimestampAfter]);
  let cursor: { at: string; id: string } | null = null;
  if (params.pageToken) {
    try {
      const [body, signature, extra] = params.pageToken.split('.');
      const expected = pageSignature(body);
      if (extra || signature?.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (parsed.filter !== filter || typeof parsed.id !== 'string' || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
      cursor = { at: parsed.at, id: parsed.id };
    } catch { throw new RequestMalformedError('Invalid page token.'); }
  }
  const where: Prisma.A2ATaskWhereInput = { context: { ...scope(grant), expiresAt: { gt: new Date() } },
    ...(params.contextId ? { contextId: params.contextId } : {}),
    ...(params.status ? { state: params.status } : {}),
    ...(params.statusTimestampAfter ? { statusAt: { gte: new Date(params.statusTimestampAfter) } } : {}),
  };
  const paged: Prisma.A2ATaskWhereInput = cursor ? { AND: [where, { OR: [
    { statusAt: { lt: new Date(cursor.at) } },
    { statusAt: new Date(cursor.at), id: { lt: cursor.id } },
  ] }] } : where;
  const [totalSize, found] = await db.$transaction([
    db.a2ATask.count({ where }), db.a2ATask.findMany({ where: paged, orderBy: [{ statusAt: 'desc' }, { id: 'desc' }], take: pageSize + 1 }),
  ]);
  const rows = found.slice(0, pageSize);
  const last = rows.at(-1);
  const body = last ? Buffer.from(JSON.stringify({ filter, at: last.statusAt.toISOString(), id: last.id })).toString('base64url') : '';
  return { tasks: rows.map((row) => historyView(Task.fromJSON(row.snapshot), params.historyLength, params.includeArtifacts ?? false)),
    pageSize, totalSize, nextPageToken: last && found.length > pageSize ? `${body}.${pageSignature(body)}` : '' };
}
export async function eventsAfter(grant: A2AGrant, id: string, sequence: number) {
  await getTaskRow(grant, id);
  return db.a2AEvent.findMany({ where: { taskId: id, sequence: { gt: sequence } }, orderBy: { sequence: 'asc' }, take: 100 });
}
