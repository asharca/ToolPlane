// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { SendMessageRequest, Task } from '@a2a-js/sdk';
import { db } from '@/lib/db';
import { REMOTE_CARD, REMOTE_RPC, remoteCard, remoteTask } from '../fixtures/a2a-remote';
import { mutateRemoteRegistry, remoteCredential, remoteRegistryView } from '@/lib/a2a/remote-registry';
import { remoteChildGrant, assertRemoteGrant } from '@/lib/a2a/remote-policy';
import { createLocalRootGrant } from '@/lib/a2a/local-policy';
import { submitTask, claimTask, finishTask, getTask, getTaskRow, interruptTask, requestCancellation } from '@/lib/a2a/store';
import { requestLocalWait, reconcileLocalWaits } from '@/lib/a2a/local-continuation';
import { executeRemoteTask, reconcileRemoteTasks } from '@/lib/a2a/remote-executor';
import { executeA2ATask, startA2AWorker, stopA2AWorker } from '@/lib/a2a/worker';
import { getConsoleTaskTree } from '@/lib/a2a/console-tasks';
import type { ConsoleActor } from '@/lib/a2a/console-service';
import type { LocalA2AGrant } from '@/lib/a2a/principal';

const network = vi.hoisted(() => ({ discover: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/db', async (original) => {
  if (process.env.TOOLPLANE_TEST_PGLITE !== '1') return original();
  const { PrismaClient } = await import('@prisma/client'); const { PrismaPg } = await import('@prisma/adapter-pg');
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) }) };
});
vi.mock('@/lib/a2a/remote-network', async (original) => ({
  ...await original<typeof import('@/lib/a2a/remote-network')>(), fetchRemoteJson: network.discover,
  // Only the network boundary is replaced; the official ClientFactory/JSONRPC transport remains unchanged.
  remoteRpcFetch: (url: string, token: string) => async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); expect(request.url).toBe(url);
    const rpc = await request.json(); const result = await network.rpc(rpc, token);
    const { validateRemoteResponse } = await import('@/lib/a2a/remote-wire'); validateRemoteResponse(rpc, result);
    return Response.json(result);
  },
}));
vi.mock('@/lib/a2a/worker', async (original) => ({ ...await original<typeof import('@/lib/a2a/worker')>(), wakeA2AWorker: vi.fn() }));

let user: string, member: string, ws: string, agent: string, otherAgent: string, remote: string;
let ctx: ConsoleActor, grant: LocalA2AGrant;
let peerState: string, peerDetail: string | undefined;
const message = (text = 'Review only this explicit text', extra: Record<string, unknown> = {}) => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra }, configuration: { returnImmediately: true },
});
async function root() { return (await claimTask((await submitTask(grant, message())).id))!; }
async function child(parent: Awaited<ReturnType<typeof root>>) {
  const authority = await remoteChildGrant(parent.id, parent.leaseToken!, remote);
  const row = await submitTask(authority, message(), { parentLeaseToken: parent.leaseToken! });
  return { grant: authority, row };
}
async function sendChild(parent: Awaited<ReturnType<typeof root>>) {
  const delegated = await child(parent), run = (await claimTask(delegated.row.id))!;
  await executeRemoteTask(run, new AbortController().signal); return delegated;
}
async function due(id: string) { await db.a2ATask.update({ where: { id }, data: { remotePollAt: new Date(0) } }); await reconcileRemoteTasks(); }
async function waiting(parent: Awaited<ReturnType<typeof root>>, id: string) {
  await requestLocalWait(parent.id, parent.leaseToken!, [id]); await finishTask(parent.id, parent.leaseToken!, 3);
}
beforeAll(async () => {
  process.env.AUTH_SECRET = 'remote-tests-isolated-secret';
  vi.stubEnv('TOOLPLANE_A2A_REMOTE_ORIGINS', JSON.stringify(['https://agent.example']));
  user = (await db.user.create({ data: { email: `${randomUUID()}@remote.test`, passwordHash: 'x' } })).id;
  member = (await db.user.create({ data: { email: `${randomUUID()}@remote.test`, passwordHash: 'x' } })).id;
  ws = (await db.workspace.create({ data: { slug: `remote-${randomUUID()}`, name: 'Remote fixture', ownerId: user,
    members: { create: { userId: member, role: 'member' } } } })).id;
  const provider = await db.modelProvider.create({ data: { workspaceId: ws, name: 'Model', format: 'openai', baseUrl: 'https://model.invalid', apiKey: 'never-export-this-model-key' } });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const dep = await db.deployment.create({ data: { workspaceId: ws, name: 'Sandbox', source: 'config' } });
    const sandbox = await db.sandbox.create({ data: { workspaceId: ws, deploymentId: dep.id, name: 'Sandbox', slug: `sandbox-${i}`, kind: 'docker', network: 'isolated' } });
    ids.push((await db.agent.create({ data: { workspaceId: ws, name: `Local ${i}`, slug: `local-${i}`, runtimeKind: 'pi', model: 'fixture', providerId: provider.id,
      a2aInternalEnabled: true, sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } } } })).id);
  }
  [agent, otherAgent] = ids; ctx = { workspaceId: ws, actorId: user, agentId: agent, slug: 'fixture' };
});
beforeEach(async () => {
  vi.clearAllMocks(); peerState = 'TASK_STATE_WORKING'; peerDetail = undefined;
  network.discover.mockResolvedValue(Response.json(remoteCard()));
  network.rpc.mockImplementation(async (rpc: { id: unknown; method: string }) => ({ jsonrpc: '2.0', id: rpc.id,
    result: rpc.method === 'SendMessage' ? { task: remoteTask(peerState, peerDetail) } : remoteTask(peerState, peerDetail) }));
  await db.a2AContext.deleteMany({ where: { workspaceId: ws } });
  await db.remoteA2AAgent.deleteMany({ where: { workspaceId: ws } });
  await db.agent.updateMany({ where: { workspaceId: ws }, data: { a2aInternalEnabled: true, systemPrompt: null } });
  grant = await createLocalRootGrant(ws, agent, user);
  remote = (await mutateRemoteRegistry(ctx, { action: 'register', name: 'Remote reviewer', cardUrl: REMOTE_CARD, rpcUrl: REMOTE_RPC, token: 'fixture-peer-key' })).id;
  await mutateRemoteRegistry(ctx, { action: 'configure', id: remote, revision: 1, enabled: true, allowCurrentAgent: true });
});
afterAll(async () => {
  stopA2AWorker(); vi.unstubAllEnvs();
  if (ws) { await db.auditEvent.deleteMany({ where: { workspaceId: ws } }); await db.workspace.delete({ where: { id: ws } }); }
  await db.user.deleteMany({ where: { id: { in: [user, member].filter(Boolean) } } }); await db.$disconnect();
});

describe('registered remote Agents in the native task core', () => {
  it('registers disabled, encrypts credentials with row binding and exposes no secret', async () => {
    network.discover.mockResolvedValueOnce(Response.json(remoteCard()));
    const id = (await mutateRemoteRegistry(ctx, { action: 'register', name: 'Another', cardUrl: REMOTE_CARD, rpcUrl: REMOTE_RPC, token: 'another-secret' })).id;
    const row = await db.remoteA2AAgent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ enabled: false, allowedAgentIds: [], revision: 1 });
    expect(JSON.stringify(row.credential)).not.toContain('another-secret'); expect(remoteCredential(row)).toBe('another-secret');
    expect(() => remoteCredential({ ...row, workspaceId: 'different' })).toThrow();
    const view = await remoteRegistryView(ctx); expect(JSON.stringify(view)).not.toMatch(/another-secret|fixture-peer-key|credential/);
    const audit = await db.auditEvent.findMany({ where: { workspaceId: ws } }); expect(JSON.stringify(audit)).not.toContain('another-secret');
  });
  it('requires current admin authority before any remote discovery and per-Agent grants', async () => {
    await expect(mutateRemoteRegistry({ ...ctx, actorId: member }, { action: 'register', name: 'Denied', cardUrl: REMOTE_CARD, rpcUrl: REMOTE_RPC })).rejects.toThrow();
    expect(network.discover).toHaveBeenCalledTimes(1);
    const viewer = await remoteRegistryView({ ...ctx, actorId: member }); expect(viewer.canManage).toBe(false);
    expect((await remoteRegistryView({ ...ctx, actorId: member, agentId: otherAgent })).agents).toHaveLength(0);
    const other = await createLocalRootGrant(ws, otherAgent, user), parent = (await claimTask((await submitTask(other, message())).id))!;
    await expect(remoteChildGrant(parent.id, parent.leaseToken!, remote)).rejects.toThrow();
  });
  it('creates native child identity without fake clients/Endpoints or exporting local authority', async () => {
    const parent = await root(), delegated = await sendChild(parent);
    const context = await db.a2AContext.findUniqueOrThrow({ where: { id: delegated.row.contextId } });
    expect(context).toMatchObject({ targetKind: 'remote', remoteAgentId: remote, workspaceId: ws, agentId: null, clientId: null, endpointId: null });
    expect(await db.agentEndpoint.count({ where: { workspaceId: ws } })).toBe(0);
    const [rpc, token] = network.rpc.mock.calls[0]; expect(rpc.method).toBe('SendMessage'); expect(token).toBe('fixture-peer-key');
    expect(rpc.params.message.messageId).not.toBe(SendMessageRequest.fromJSON(delegated.row.request).message?.messageId);
    for (const secret of [ws, user, agent, parent.id, delegated.row.id, parent.leaseToken!, 'never-export-this-model-key']) expect(JSON.stringify(rpc)).not.toContain(secret);
    expect(rpc.params).not.toHaveProperty('metadata'); expect(rpc.params.configuration.returnImmediately).toBe(true);
    await expect(getTask(grant, delegated.row.id)).rejects.toThrow();
  });
  it('releases the execution lease and resumes a waiting parent without a second SendMessage', async () => {
    const parent = await root(), delegated = await sendChild(parent); await waiting(parent, delegated.row.id);
    expect(await getTaskRow(delegated.grant, delegated.row.id)).toMatchObject({ phase: 'remote-waiting', state: 2, leaseToken: null });
    peerState = 'TASK_STATE_COMPLETED'; await due(delegated.row.id); await reconcileLocalWaits();
    const resumed = (await claimTask(parent.id))!; expect(resumed.resumeCount).toBe(1);
    expect(JSON.stringify(Task.fromJSON(resumed.snapshot).history)).toContain('Remote review result');
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual(['SendMessage', 'GetTask']);
    const tree = await getConsoleTaskTree(ctx, parent.id, delegated.row.id); expect(tree.nodes).toHaveLength(2);
    expect(tree.selectedTask).toMatchObject({ id: delegated.row.id, status: { state: 'TASK_STATE_COMPLETED' } });
  });
  it('keeps remote task/context IDs stable through input-required continuation', async () => {
    const parent = await root(); peerState = 'TASK_STATE_INPUT_REQUIRED'; peerDetail = 'Which branch?';
    const delegated = await sendChild(parent); await waiting(parent, delegated.row.id); await reconcileLocalWaits();
    const resumed = (await claimTask(parent.id))!;
    const authority = await remoteChildGrant(parent.id, resumed.leaseToken!, remote);
    const follow = await submitTask(authority, message('main', { taskId: delegated.row.id }), { parentLeaseToken: resumed.leaseToken! });
    peerState = 'TASK_STATE_COMPLETED'; peerDetail = undefined;
    const run = (await claimTask(follow.id))!; await executeRemoteTask(run, new AbortController().signal);
    const calls = network.rpc.mock.calls.map(([rpc]) => rpc); expect(calls).toHaveLength(2);
    expect(calls[1].params.message).toMatchObject({ taskId: 'peer-task', contextId: 'peer-context' });
    expect(calls[1].params.message.messageId).not.toBe(calls[0].params.message.messageId);
    expect((await getTask(authority, follow.id)).status?.state).toBe(3); expect(follow.deadlineAt).toEqual(delegated.row.deadlineAt);
  });
  it('does not claim cancellation until the peer confirms and sends CancelTask at most once', async () => {
    const parent = await root(), delegated = await sendChild(parent);
    expect((await requestCancellation(delegated.grant, delegated.row.id)).status?.state).toBe(2);
    await due(delegated.row.id); expect((await getTask(delegated.grant, delegated.row.id)).status?.state).toBe(2);
    peerState = 'TASK_STATE_CANCELED'; await due(delegated.row.id);
    expect((await getTask(delegated.grant, delegated.row.id)).status?.state).toBe(5);
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual(['SendMessage', 'CancelTask', 'GetTask']);
  });
  it('cancels a queued input continuation without resending its business message', async () => {
    const parent = await root(); peerState = 'TASK_STATE_INPUT_REQUIRED'; peerDetail = 'Which branch?';
    const delegated = await sendChild(parent); await waiting(parent, delegated.row.id); await reconcileLocalWaits();
    const resumed = (await claimTask(parent.id))!;
    const authority = await remoteChildGrant(parent.id, resumed.leaseToken!, remote);
    await submitTask(authority, message('main', { taskId: delegated.row.id }), { parentLeaseToken: resumed.leaseToken! });
    await requestCancellation(authority, delegated.row.id);
    await waiting(resumed, delegated.row.id); await due(delegated.row.id); await reconcileLocalWaits();
    expect((await getTaskRow(grant, parent.id)).phase).toBe('waiting');
    peerState = 'TASK_STATE_CANCELED'; peerDetail = undefined; await due(delegated.row.id);
    await reconcileLocalWaits(); expect((await getTaskRow(grant, parent.id)).phase).toBe('resumable');
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual(['SendMessage', 'CancelTask', 'GetTask']);
  });
  it('observes externally resolved remote authorization without model approval or new submission', async () => {
    const parent = await root(); peerState = 'TASK_STATE_AUTH_REQUIRED';
    const delegated = await sendChild(parent);
    await expect(submitTask(delegated.grant, message('approved', { taskId: delegated.row.id }), { parentLeaseToken: parent.leaseToken! })).rejects.toThrow();
    peerState = 'TASK_STATE_WORKING'; await due(delegated.row.id);
    peerState = 'TASK_STATE_COMPLETED'; await due(delegated.row.id);
    expect((await getTask(delegated.grant, delegated.row.id)).status?.state).toBe(3);
    expect(network.rpc.mock.calls.filter(([rpc]) => rpc.method === 'SendMessage')).toHaveLength(1);
  });
  it('propagates root cancellation but can still cancel the known remote child', async () => {
    const parent = await root(), delegated = await sendChild(parent); await waiting(parent, delegated.row.id);
    await requestCancellation(grant, parent.id); expect((await getTask(grant, parent.id)).status?.state).toBe(5);
    peerState = 'TASK_STATE_CANCELED'; await due(delegated.row.id);
    expect((await getTask(delegated.grant, delegated.row.id)).status?.state).toBe(5);
  });
  it('fails an uncertain submission without automatic resend or false cancellation', async () => {
    const parent = await root(), delegated = await child(parent);
    network.rpc.mockRejectedValueOnce(new Error('secret upstream exception'));
    await executeA2ATask(delegated.row.id);
    const task = await getTask(delegated.grant, delegated.row.id); expect(task.status?.state).toBe(4);
    expect(JSON.stringify(task)).not.toContain('secret upstream exception'); expect(JSON.stringify(task)).toContain('may still');
    await executeA2ATask(delegated.row.id); await due(delegated.row.id); expect(network.rpc).toHaveBeenCalledTimes(1);
  });
  it('invalidates outstanding tasks on key rotation or access revocation', async () => {
    const parent = await root(), delegated = await sendChild(parent);
    await mutateRemoteRegistry(ctx, { action: 'replace-key', id: remote, revision: 2, token: 'new-key' });
    await expect(assertRemoteGrant(delegated.grant)).rejects.toThrow();
    await due(delegated.row.id); expect((await getTask(delegated.grant, delegated.row.id)).status?.state).toBe(4);
    expect(network.rpc).toHaveBeenCalledTimes(1);
    await expect(getConsoleTaskTree(ctx, parent.id, delegated.row.id)).rejects.toThrow();
    await expect(mutateRemoteRegistry(ctx, { action: 'configure', id: remote, revision: 2, enabled: true })).rejects.toThrow();
  });
  it('withholds completed remote output from automatic continuation after authorization changes', async () => {
    const parent = await root(); peerState = 'TASK_STATE_COMPLETED';
    const delegated = await sendChild(parent); await waiting(parent, delegated.row.id);
    await mutateRemoteRegistry(ctx, { action: 'configure', id: remote, revision: 2, allowCurrentAgent: false });
    await reconcileLocalWaits(); const resumed = (await claimTask(parent.id))!;
    const history = JSON.stringify(Task.fromJSON(resumed.snapshot).history);
    expect(history).not.toContain('Remote review result'); expect(history).toContain('withheld');
  });
  it('rejects forged ancestry/actor/lease and cross-workspace configuration', async () => {
    const parent = await root(), delegated = await child(parent);
    await expect(submitTask(delegated.grant, message(), { parentLeaseToken: 'wrong' })).rejects.toThrow();
    await expect(assertRemoteGrant({ ...delegated.grant, actorId: member })).rejects.toThrow();
    await expect(assertRemoteGrant({ ...delegated.grant, ancestorTaskIds: [randomUUID()] })).rejects.toThrow();
    await expect(mutateRemoteRegistry({ ...ctx, workspaceId: randomUUID() }, { action: 'configure', id: remote, revision: 2, enabled: false })).rejects.toThrow();
  });
  it('ignores stale observation errors after a newer phase/generation', async () => {
    const parent = await root(), delegated = await sendChild(parent);
    const row = await getTaskRow(delegated.grant, delegated.row.id);
    await db.a2ATask.update({ where: { id: row.id }, data: { remoteMessageId: 'new-generation' } });
    await interruptTask(row.id, 'stale', { phase: 'remote-waiting', remoteMessageId: row.remoteMessageId });
    expect((await getTaskRow(delegated.grant, row.id)).state).toBe(2);
  });
  it('bounds failed read retries without issuing another business message', async () => {
    const parent = await root(), delegated = await sendChild(parent);
    network.rpc.mockRejectedValue(new Error('read failed'));
    for (let i = 0; i < 5; i++) await due(delegated.row.id);
    expect((await getTask(delegated.grant, delegated.row.id)).status?.state).toBe(4);
    expect(network.rpc.mock.calls.filter(([rpc]) => rpc.method === 'SendMessage')).toHaveLength(1);
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === '1')('claims a remote task only once under concurrent PostgreSQL transactions', async () => {
    const parent = await root(), delegated = await child(parent);
    const claims = await Promise.all([claimTask(delegated.row.id), claimTask(delegated.row.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('recovers a known remote task by observation only, never replaying SendMessage', async () => {
    const parent = await root(), delegated = await sendChild(parent); await waiting(parent, delegated.row.id);
    await db.a2ATask.update({ where: { id: delegated.row.id }, data: { phase: 'executing', leaseToken: 'obsolete', remotePollAt: new Date(0) } });
    await startA2AWorker(); stopA2AWorker();
    expect((await getTaskRow(delegated.grant, delegated.row.id))).toMatchObject({ phase: 'remote-waiting', leaseToken: null });
    peerState = 'TASK_STATE_COMPLETED'; await due(delegated.row.id);
    expect(network.rpc.mock.calls.map(([rpc]) => rpc.method)).toEqual(['SendMessage', 'GetTask']);
  });
});
