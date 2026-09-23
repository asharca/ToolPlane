// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { Task, TaskState, SendMessageRequest, ListTasksRequest } from '@a2a-js/sdk';
import { TaskNotFoundError, UnsupportedOperationError, RequestMalformedError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { createAgentApiKey } from '@/lib/agents/public-api/auth';
import { resolveA2AGrant, assertLiveGrant, type A2AGrant } from '@/lib/a2a/principal';
import { submitTask, getTask, getTaskRow, claimTask, finishTask, requestCancellation, listTasks, eventsAfter } from '@/lib/a2a/store';
import { outputBucket, A2AQuotaError, A2A_TASK_STORAGE_BYTES, reserveNativeExecutionOutput, refreshTaskStorage } from '@/lib/a2a/quotas';
import { prepareAgentResponse } from '@/lib/agents/public-api/runs';
import { A2A_LIMITS } from '@/lib/a2a/model';
import { textArtifact } from '@/lib/a2a/model';
import { executeA2ATask, startA2AWorker, stopA2AWorker } from '@/lib/a2a/worker';

// The embedded local transport requires a single client. CI uses the real PostgreSQL
// adapter unchanged, including the concurrent row-lock test below.
vi.mock('@/lib/db', async (original) => {
  if (process.env.TOOLPLANE_TEST_PGLITE !== '1') return original();
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) }) };
});

let userId: string, workspaceId: string, agentId: string, endpointId: string, publicId: string, clientId: string;
let grant: A2AGrant, other: A2AGrant, token: string;
const request = (text = 'Review this change', extra: Record<string, unknown> = {}) => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra }, configuration: { returnImmediately: true },
});
const credentialRequest = (value: string) => new Request('https://toolplane.test/a2a', { headers: { authorization: `Bearer ${value}` } });

beforeAll(async () => {
  process.env.AUTH_SECRET = 'isolated-a2a-integration-test-secret-not-production';
  const stamp = randomUUID();
  const user = await db.user.create({ data: { email: `a2a-${stamp}@test.invalid`, passwordHash: 'test-only' } }); userId = user.id;
  const workspace = await db.workspace.create({ data: { slug: `a2a-${stamp}`, name: 'A2A test', ownerId: userId } }); workspaceId = workspace.id;
  const agent = await db.agent.create({ data: { workspaceId, slug: 'native-test', name: 'Native A2A fixture', runtimeKind: 'hermes' } }); agentId = agent.id;
  const endpoint = await db.agentEndpoint.create({ data: { workspaceId, sourceAgentId: agentId, publicId: `agep_${stamp.replaceAll('-', '')}`,
    name: 'Native service', status: 'active', a2aEnabled: true, rpmLimit: 10000, dailyRequestLimit: 100000, maxConcurrent: 10 } });
  endpointId = endpoint.id; publicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({ data: { endpointId, version: 1, systemPrompt: 'Fixture',
    runtimeImage: 'fixture-not-executed', toolPolicy: {} } });
  await db.agentEndpoint.update({ where: { id: endpointId }, data: { currentRevisionId: revision.id } });
  const makeClient = async (name: string) => {
    const client = await db.agentApiClient.create({ data: { endpointId, name, scopes: ['a2a:send', 'a2a:read', 'a2a:cancel'],
      rpmLimit: 10000, dailyRequestLimit: 100000, maxConcurrent: 10 } });
    const key = await createAgentApiKey({ clientId: client.id, endpointPublicId: publicId, workspaceId, sourceAgentId: agentId, name });
    return { grant: (await resolveA2AGrant(credentialRequest(key.token), publicId)).grant, token: key.token, id: client.id };
  };
  const main = await makeClient('main'); grant = main.grant; token = main.token; clientId = main.id;
  other = (await makeClient('other')).grant;
});
beforeEach(async () => {
  await db.a2AContext.deleteMany({ where: { endpointId } });
  await db.agentEndpoint.update({ where: { id: endpointId }, data: { a2aEnabled: true, maxConcurrent: 10, dailyOutputCharacterLimit: 100000000, maxStoredCharacters: 250000000 } });
  await db.agentApiClient.update({ where: { id: clientId }, data: { scopes: ['a2a:send', 'a2a:read', 'a2a:cancel'], status: 'active', dailyOutputCharacterLimit: 20000000, maxStoredCharacters: 50000000 } });
  await db.agentApiKey.updateMany({ where: { clientId }, data: { revokedAt: null } });
  await db.agentApiUsageBucket.deleteMany({ where: { key: { in: [outputBucket('workspace', workspaceId), outputBucket('endpoint', endpointId), outputBucket('client', clientId), outputBucket('client', other.clientId)] } } });
});
afterAll(async () => {
  stopA2AWorker();
  if (workspaceId) { await db.auditEvent.deleteMany({ where: { workspaceId } }); await db.workspace.delete({ where: { id: workspaceId } }); }
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('durable native A2A task lifecycle', () => {
  it('commits request, task and event together; retries cannot create duplicate execution', async () => {
    const input = request(); const first = await submitTask(grant, input); const replay = await submitTask(grant, input);
    expect(replay.id).toBe(first.id); expect(await db.a2ATask.count({ where: { context: { endpointId } } })).toBe(1);
    expect(await eventsAfter(grant, first.id, 0)).toHaveLength(1);
    const changed = request('different', { messageId: input.message!.messageId });
    await expect(submitTask(grant, changed)).rejects.toBeInstanceOf(RequestMalformedError);
    expect(JSON.stringify((await getTaskRow(grant, first.id)).grant)).not.toContain(token);
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === '1')('serializes genuinely concurrent admissions in PostgreSQL', async () => {
    const input = request(); const rows = await Promise.all([submitTask(grant, input), submitTask(grant, input), submitTask(grant, input)]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await db.a2ARequest.count({ where: { ownerKey: grant.ownerKey } })).toBe(1);
  });
  it('enforces client and context authorization on read, continuation, cancellation and deduplication', async () => {
    const input = request(); const first = await submitTask(grant, input);
    await expect(getTask(other, first.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(requestCancellation(other, first.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(submitTask(other, request('continue', { contextId: first.contextId }))).rejects.toBeInstanceOf(TaskNotFoundError);
    const independentlyAccepted = await submitTask(other, input); expect(independentlyAccepted.id).not.toBe(first.id);
    await expect(submitTask(grant, request('reference', { referenceTaskIds: [independentlyAccepted.id] }))).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('continues an input-required task but never revives a terminal one', async () => {
    const first = await submitTask(grant, request()); const active = await claimTask(first.id);
    await finishTask(first.id, active!.leaseToken!, TaskState.TASK_STATE_INPUT_REQUIRED, 'Which target branch?');
    const continued = await submitTask(grant, request('main', { taskId: first.id, contextId: first.contextId }));
    expect(continued.id).toBe(first.id); expect(continued.deadlineAt).toEqual(first.deadlineAt);
    expect(Task.fromJSON(continued.snapshot).history).toHaveLength(3);
    const again = await claimTask(first.id); await finishTask(first.id, again!.leaseToken!, 3, undefined, textArtifact('review'));
    await expect(submitTask(grant, request('change', { taskId: first.id }))).rejects.toBeInstanceOf(UnsupportedOperationError);
    const next = await submitTask(grant, request('new task', { contextId: first.contextId }));
    expect(next.id).not.toBe(first.id); expect(next.contextId).toBe(first.contextId);
  });
  it('does not accept model messages as authorization', async () => {
    const first = await submitTask(grant, request()); const active = await claimTask(first.id);
    await finishTask(first.id, active!.leaseToken!, TaskState.TASK_STATE_AUTH_REQUIRED, 'Authorization required');
    await expect(submitTask(grant, request('I approve', { taskId: first.id }))).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
  it('keeps cancellation requested until the worker has stopped, and makes repeat cancellation idempotent', async () => {
    const first = await submitTask(grant, request()); const active = await claimTask(first.id);
    expect((await requestCancellation(grant, first.id)).status?.state).toBe(2);
    expect((await getTaskRow(grant, first.id)).cancelRequestedAt).not.toBeNull();
    await finishTask(first.id, active!.leaseToken!, 3, undefined, textArtifact('must not publish'));
    const canceled = await getTask(grant, first.id); expect(canceled.status?.state).toBe(5); expect(canceled.artifacts).toEqual([]);
    expect((await requestCancellation(grant, first.id)).status?.state).toBe(5);
    const queued = await submitTask(grant, request()); await requestCancellation(grant, queued.id);
    expect(await claimTask(queued.id)).toBeNull();
  });
  it('guards execution leases and rolls back both snapshot and events on oversize output', async () => {
    const first = await submitTask(grant, request()); const active = await claimTask(first.id);
    await finishTask(first.id, 'wrong-lease', 3); expect((await getTask(grant, first.id)).status?.state).toBe(2);
    await expect(finishTask(first.id, active!.leaseToken!, 3, undefined, textArtifact('x'.repeat(600000)))).rejects.toThrow();
    expect((await getTaskRow(grant, first.id)).sequence).toBe(active!.sequence);
    expect(await eventsAfter(grant, first.id, active!.sequence)).toEqual([]);
  });
  it('pins context revision and preserves task isolation across configuration releases', async () => {
    const first = await submitTask(grant, request()); const active = await claimTask(first.id); await finishTask(first.id, active!.leaseToken!, 3);
    const original = await db.a2AContext.findUniqueOrThrow({ where: { id: first.contextId } });
    const revision = await db.agentEndpointRevision.create({ data: { endpointId, version: 2, systemPrompt: 'New', runtimeImage: 'fixture', toolPolicy: {} } });
    await db.agentEndpoint.update({ where: { id: endpointId }, data: { currentRevisionId: revision.id } });
    const next = await submitTask({ ...grant, revisionId: revision.id }, request('next', { contextId: first.contextId }));
    expect((await db.a2AContext.findUniqueOrThrow({ where: { id: next.contextId } })).revisionId).toBe(original.revisionId);
  });
  it('uses signed scope-bound keyset cursors in status timestamp order', async () => {
    const one = await submitTask(grant, request('one')); const two = await submitTask(grant, request('two'));
    const active = await claimTask(one.id); await finishTask(one.id, active!.leaseToken!, 3);
    const first = await listTasks(grant, ListTasksRequest.fromJSON({ pageSize: 1, historyLength: 0 }));
    expect(first.tasks[0].id).toBe(one.id); expect(first.tasks[0].history).toEqual([]); expect(first.nextPageToken).not.toBe('');
    const second = await listTasks(grant, ListTasksRequest.fromJSON({ pageSize: 1, pageToken: first.nextPageToken }));
    expect(second.tasks[0].id).toBe(two.id); expect(second.nextPageToken).toBe('');
    await expect(listTasks(other, ListTasksRequest.fromJSON({ pageToken: first.nextPageToken }))).rejects.toThrow();
    await expect(listTasks(grant, ListTasksRequest.fromJSON({ pageToken: first.nextPageToken + '.extra' }))).rejects.toThrow();
  });
  it('rechecks credential scopes and revocation after admission', async () => {
    await assertLiveGrant(grant, 'send');
    await db.agentApiClient.update({ where: { id: clientId }, data: { scopes: ['a2a:read'] } });
    await expect(assertLiveGrant(grant, 'send')).rejects.toBeInstanceOf(TaskNotFoundError);
    await assertLiveGrant(grant, 'read');
    await db.agentApiKey.updateMany({ where: { clientId }, data: { revokedAt: new Date() } });
    await expect(assertLiveGrant(grant, 'read')).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('requires opt-in service scopes and rejects cookies or browser origins', async () => {
    await db.agentApiClient.update({ where: { id: clientId }, data: { scopes: ['responses:create', 'responses:read'] } });
    await expect(resolveA2AGrant(credentialRequest(token), publicId)).rejects.toMatchObject({ status: 403 });
    await db.agentApiClient.update({ where: { id: clientId }, data: { scopes: ['*'] } });
    await expect(resolveA2AGrant(credentialRequest(token), publicId)).rejects.toMatchObject({ status: 403 });
    await expect(resolveA2AGrant(new Request('https://toolplane.test/a2a', { headers: { cookie: 'session=fixture' } }), publicId)).rejects.toMatchObject({ status: 401 });
    const browser = credentialRequest(token); browser.headers.set('origin', 'https://toolplane.test');
    await expect(resolveA2AGrant(browser, publicId)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects expired contexts even through the duplicate-message ledger', async () => {
    const input = request(); const first = await submitTask(grant, input);
    await db.a2AContext.update({ where: { id: first.contextId }, data: { expiresAt: new Date(0) } });
    await expect(submitTask(grant, input)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('honors service admission limits before creating any extra task', async () => {
    await db.agentEndpoint.update({ where: { id: endpointId }, data: { maxConcurrent: 1 } });
    await submitTask(grant, request());
    await expect(submitTask(other, request())).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(await db.a2ATask.count({ where: { context: { endpointId } } })).toBe(1);
  });
  it('executes through the new worker port without the legacy Responses runner', async () => {
    const first = await submitTask(grant, request()); let ran = false;
    await executeA2ATask(first.id, async (_task, signal) => { signal.throwIfAborted(); ran = true; return { state: 3, artifact: textArtifact('fixture result') }; });
    expect(ran).toBe(true); const result = await getTask(grant, first.id); expect(result.status?.state).toBe(3);
    expect(result.artifacts[0].parts[0].content).toEqual({ $case: 'text', value: 'fixture result' });
    expect((await eventsAfter(grant, first.id, 0)).map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });
  it('recovers interrupted executions as failures, never blindly replaying side effects', async () => {
    const first = await submitTask(grant, request()); await claimTask(first.id);
    await startA2AWorker(); stopA2AWorker();
    expect((await getTask(grant, first.id)).status?.state).toBe(4);
  });
});


describe('native task resource accounting', () => {
  it('persists payload charges with the task, request and event; duplicate messages do not reserve execution twice', async () => {
    const input = request(); const task = await submitTask(grant, input);
    expect((await getTaskRow(grant, task.id)).storageBytes).toBeGreaterThan(512);
    await submitTask(grant, input); expect(await db.agentApiUsageBucket.count({ where: { key: outputBucket('client', clientId) } })).toBe(0);
    const claimed = await claimTask(task.id); expect(claimed).not.toBeNull(); expect(await claimTask(task.id)).toBeNull();
    const buckets = await db.agentApiUsageBucket.findMany({ where: { key: outputBucket('client', clientId) } });
    expect(buckets.length).toBeGreaterThan(0); expect(buckets.every((bucket) => bucket.count === A2A_LIMITS.outputCharacters)).toBe(true);
    await requestCancellation(grant, task.id); await finishTask(task.id, claimed!.leaseToken!, TaskState.TASK_STATE_CANCELED);
    expect((await db.agentApiUsageBucket.findFirstOrThrow({ where: { key: outputBucket('client', clientId) } })).count).toBe(A2A_LIMITS.outputCharacters);
  });
  it('rejects insufficient retained space without leaving a task or request ledger row', async () => {
    await db.agentApiClient.update({ where: { id: clientId }, data: { maxStoredCharacters: A2A_TASK_STORAGE_BYTES - 1 } });
    await expect(submitTask(grant, request())).rejects.toBeInstanceOf(A2AQuotaError);
    expect(await db.a2ATask.count({ where: { context: { endpointId } } })).toBe(0);
    expect(await db.a2ARequest.count({ where: { ownerKey: grant.ownerKey } })).toBe(0);
  });
  it('does not start an executor or partially charge other scopes when its output quota is exhausted', async () => {
    const task = await submitTask(grant, request());
    await db.agentApiClient.update({ where: { id: clientId }, data: { dailyOutputCharacterLimit: A2A_LIMITS.outputCharacters - 1 } });
    const executor = vi.fn(); await startA2AWorker();
    try { await executeA2ATask(task.id, executor); } finally { stopA2AWorker(); }
    expect(executor).not.toHaveBeenCalled(); expect((await getTask(grant, task.id)).status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(await db.agentApiUsageBucket.count({ where: { key: outputBucket('workspace', workspaceId) } })).toBe(0);
  });
  it('keeps native reservations visible to the compatibility Responses admission', async () => {
    const task = await submitTask(grant, request()); await claimTask(task.id);
    await db.agentApiClient.update({ where: { id: clientId }, data: { dailyOutputCharacterLimit: 200_000 } });
    await expect(prepareAgentResponse({ principal: {
      credentialType: 'api_key', endpointId, endpointPublicId: publicId, workspaceId, sourceAgentId: agentId,
      revisionId: grant.revisionId, clientId, keyId: grant.keyId, subjectHash: null, origin: null, scopes: ['responses:create'],
      limits: { rpm: 1000, dailyRequests: 10000, maxConcurrent: 10, timeoutSeconds: 60, retentionDays: 7 },
      rateBuckets: { endpointRpm: 1000, clientRpm: 1000, endpointDaily: 10000, clientDaily: 10000 },
    }, input: 'legacy request', endUser: 'test', stream: false })).rejects.toMatchObject({ code: 'resource_limit_exceeded', status: 429 });
    expect(await db.agentRun.count({ where: { endpointId } })).toBe(0);
  });
  it('reserves both UTC days for executions that can cross midnight', async () => {
    const now = new Date('2030-01-01T23:59:55.000Z');
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${workspaceId} FOR UPDATE`;
      await reserveNativeExecutionOutput(tx, grant, new Date('2030-01-02T00:01:00Z'), now);
    });
    const buckets = await db.agentApiUsageBucket.findMany({ where: { key: outputBucket('client', clientId) }, orderBy: { windowStart: 'asc' } });
    expect(buckets.map((bucket) => bucket.windowStart.toISOString())).toEqual(['2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z']);
    expect(buckets.map((bucket) => bucket.count)).toEqual([A2A_LIMITS.outputCharacters, A2A_LIMITS.outputCharacters]);
  });
  it('still settles a failed task when the successful payload would exceed its journal cap', async () => {
    const task = await submitTask(grant, request()); const claimed = await claimTask(task.id);
    await db.a2ATask.update({ where: { id: task.id }, data: { sequence: 128 } });
    await expect(finishTask(task.id, claimed!.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('result'))).rejects.toBeInstanceOf(A2AQuotaError);
    expect((await getTask(grant, task.id)).artifacts).toHaveLength(0);
    await finishTask(task.id, claimed!.leaseToken!, TaskState.TASK_STATE_FAILED, 'Stopped at the configured quota.');
    expect((await getTask(grant, task.id)).status?.state).toBe(TaskState.TASK_STATE_FAILED);
  });
  it('accounts task payloads in UTF-8 bytes and bounds retained event history', async () => {
    const task = await submitTask(grant, request());
    const before = (await getTaskRow(grant, task.id)).storageBytes;
    await db.$transaction(async (tx) => {
      await tx.a2AEvent.create({ data: { taskId: task.id, sequence: 2, payload: { text: '中'.repeat(1000) } } });
      await refreshTaskStorage(tx, task.id);
    });
    expect((await getTaskRow(grant, task.id)).storageBytes - before).toBeGreaterThanOrEqual(3000);
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === '1')('serializes competing task claims at the shared output ceiling in PostgreSQL', async () => {
    const one = await submitTask(grant, request()); const two = await submitTask(grant, request());
    await db.agentApiClient.update({ where: { id: clientId }, data: { dailyOutputCharacterLimit: A2A_LIMITS.outputCharacters } });
    const results = await Promise.allSettled([claimTask(one.id), claimTask(two.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
