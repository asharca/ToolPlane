// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { Task, TaskState, SendMessageRequest, ListTasksRequest } from '@a2a-js/sdk';
import { TaskNotFoundError, UnsupportedOperationError, RequestMalformedError } from '@a2a-js/sdk/errors';
import { db } from '@/lib/db';
import { createAgentApiKey } from '@/lib/agents/public-api/auth';
import { resolveA2AGrant, assertLiveGrant, type A2AGrant } from '@/lib/a2a/principal';
import { submitTask, getTask, getTaskRow, claimTask, finishTask, requestCancellation, listTasks, eventsAfter } from '@/lib/a2a/store';
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
  await db.agentEndpoint.update({ where: { id: endpointId }, data: { a2aEnabled: true, maxConcurrent: 10 } });
  await db.agentApiClient.update({ where: { id: clientId }, data: { scopes: ['a2a:send', 'a2a:read', 'a2a:cancel'], status: 'active' } });
  await db.agentApiKey.updateMany({ where: { clientId }, data: { revokedAt: null } });
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
