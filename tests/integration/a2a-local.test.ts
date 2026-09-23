// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { Message, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { publishLocalArtifact } from '@/lib/a2a/local-artifacts';
import { getConsoleTaskTree } from '@/lib/a2a/console-tasks';
import { createLocalRootGrant, childGrant, assertLocalGrant, LOCAL_LIMITS } from '@/lib/a2a/local-policy';
import { type LocalA2AGrant } from '@/lib/a2a/principal';
import { submitTask, claimTask, finishTask, getTask, getTaskRow, requestCancellation, eventsAfter } from '@/lib/a2a/store';
import { requestLocalWait, requestLocalInput, reconcileLocalWaits } from '@/lib/a2a/local-continuation';
import { textArtifact } from '@/lib/a2a/model';
import { workbenchMessage } from '@/lib/a2a/workbench-client';
import { listWorkbenchAgents } from '@/lib/a2a/workbench';
import { executeA2ATask, startA2AWorker, stopA2AWorker } from '@/lib/a2a/worker';
import { createAgentRuntimeToken, type AgentRuntimeTokenPayload } from '@/lib/agents/runtime-access';
import { assertLocalRuntimeToken } from '@/lib/a2a/local-runtime';
import { handleLocalMcp, executeLocalMcpTool } from '@/lib/a2a/local-mcp';
import { withSandboxExecutionLease } from '@/lib/agents/sandbox-execution-gate';
import { isAgentRuntimeGrantCurrent } from '@/lib/agents/runtime-grant';

vi.mock('@/lib/db', async (original) => {
  if (process.env.TOOLPLANE_TEST_PGLITE !== '1') return original();
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) }) };
});
vi.mock('@/lib/a2a/worker', async (original) => ({ ...await original<typeof import('@/lib/a2a/worker')>(), wakeA2AWorker: vi.fn() }));

let ws: string, user: string, otherUser: string, provider: string;
const agents: string[] = [], sandboxes: string[] = [];
let grant: LocalA2AGrant;
const request = (text = 'Do this task', extra: Record<string, unknown> = {}) => SendMessageRequest.fromJSON({
  message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra }, configuration: { returnImmediately: true },
});
async function root() { return claimTask((await submitTask(grant, request())).id).then((r) => r!); }
async function child(parent: Awaited<ReturnType<typeof root>>, index = 1, input = request()) {
  const authority = await childGrant(parent.id, parent.leaseToken!, agents[index]);
  return { grant: authority, row: await submitTask(authority, input, { parentLeaseToken: parent.leaseToken! }) };
}
function runtimeToken(parent: Awaited<ReturnType<typeof root>>, index = 0): AgentRuntimeTokenPayload {
  return { workspaceId: ws, agentId: agents[index], sandboxId: sandboxes[index], providerId: provider,
    deploymentIds: [], exp: Math.floor(Date.now() / 1000) + 300, a2aTaskId: parent.id, a2aLeaseToken: parent.leaseToken! };
}
beforeAll(async () => {
  process.env.AUTH_SECRET = 'local-a2a-test-secret-not-production';
  const stamp = randomUUID();
  user = (await db.user.create({ data: { email: `local-a2a-${stamp}@test.invalid`, passwordHash: 'x' } })).id;
  otherUser = (await db.user.create({ data: { email: `local-a2a-other-${stamp}@test.invalid`, passwordHash: 'x' } })).id;
  ws = (await db.workspace.create({ data: { slug: `local-a2a-${stamp}`, name: 'Local A2A test', ownerId: user,
    members: { create: { userId: otherUser, role: 'member' } } } })).id;
  provider = (await db.modelProvider.create({ data: { workspaceId: ws, name: 'Fixture', format: 'openai',
    baseUrl: 'https://model.test.invalid', apiKey: 'fixture-secret-never-serialized' } })).id;
  for (let i = 0; i < 5; i++) {
    const dep = await db.deployment.create({ data: { workspaceId: ws, name: `Sandbox ${i}`, source: 'config' } });
    const sandbox = await db.sandbox.create({ data: { workspaceId: ws, deploymentId: dep.id, name: `Sandbox ${i}`, slug: `s-${i}`, kind: 'docker', network: 'isolated' } });
    const agent = await db.agent.create({ data: { workspaceId: ws, name: `Agent ${i}`, slug: `a-${i}`,
      runtimeKind: ['pi', 'claude-code', 'dsh', 'hermes-rpc', 'pi'][i], providerId: provider, model: 'fixture', a2aInternalEnabled: true,
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } } } });
    agents.push(agent.id); sandboxes.push(sandbox.id);
  }
});
beforeEach(async () => {
  await db.a2AContext.deleteMany({ where: { workspaceId: ws } });
  await db.agentSubAgent.deleteMany({ where: { parentId: { in: agents } } });
  await db.agentSubAgent.createMany({ data: [
    { parentId: agents[0], childId: agents[1] }, { parentId: agents[0], childId: agents[2] },
    { parentId: agents[1], childId: agents[3] }, { parentId: agents[3], childId: agents[4] },
  ] });
  await db.agent.updateMany({ where: { workspaceId: ws }, data: { a2aInternalEnabled: true, systemPrompt: null } });
  await db.workspace.update({ where: { id: ws }, data: { status: 'active' } });
  await db.user.update({ where: { id: user }, data: { status: 'active' } });
  grant = await createLocalRootGrant(ws, agents[0], user);
});
afterAll(async () => {
  stopA2AWorker();
  if (ws) { await db.auditEvent.deleteMany({ where: { workspaceId: ws } }); await db.workspace.delete({ where: { id: ws } }); }
  await db.user.deleteMany({ where: { id: { in: [user, otherUser].filter(Boolean) } } });
  await db.$disconnect();
});

describe('local Agents use native A2A tasks', () => {
  it('creates no public client, endpoint, AgentRun or private Conversation', async () => {
    const before = await db.agentRun.count(); const parent = await root(); await child(parent);
    expect(await db.agentApiClient.count({ where: { endpoint: { workspaceId: ws } } })).toBe(0);
    expect(await db.agentEndpoint.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await db.conversation.count({ where: { agentId: { in: agents } } })).toBe(0);
    expect(await db.agentRun.count()).toBe(before);
    const ctx = await db.a2AContext.findUniqueOrThrow({ where: { id: parent.contextId } });
    expect(ctx).toMatchObject({ targetKind: 'local', workspaceId: ws, agentId: agents[0], endpointId: null, clientId: null, revisionId: null });
    expect(JSON.stringify(parent.grant)).not.toContain('fixture-secret');
  });
  it('isolates account roots and separate parent tasks', async () => {
    const parent = await root(); const delegated = await child(parent);
    const other = await createLocalRootGrant(ws, agents[0], otherUser);
    await expect(getTask(other, parent.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(getTask(grant, delegated.row.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    const second = await root(); const secondGrant = await childGrant(second.id, second.leaseToken!, agents[1]);
    await expect(getTask(secondGrant, delegated.row.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('requires explicit local enablement and an allowlisted edge', async () => {
    await db.agent.update({ where: { id: agents[1] }, data: { a2aInternalEnabled: false } });
    const parent = await root();
    await expect(childGrant(parent.id, parent.leaseToken!, agents[1])).rejects.toThrow();
    await expect(childGrant(parent.id, parent.leaseToken!, agents[4])).rejects.toThrow();
  });
  it('rejects root cycles, excessive depth and forged current-run leases', async () => {
    const parent = await root(); const b = await child(parent); const bRun = (await claimTask(b.row.id))!;
    await expect(childGrant(bRun.id, bRun.leaseToken!, agents[0])).rejects.toThrow();
    await expect(childGrant(parent.id, 'wrong', agents[1])).rejects.toThrow();
    await expect(submitTask(b.grant, request(), { parentLeaseToken: 'wrong' })).rejects.toThrow();
    const c = await childGrant(bRun.id, bRun.leaseToken!, agents[3]);
    const cRun = (await claimTask((await submitTask(c, request(), { parentLeaseToken: bRun.leaseToken! })).id))!;
    const d = await childGrant(cRun.id, cRun.leaseToken!, agents[4]);
    const dRun = (await claimTask((await submitTask(d, request(), { parentLeaseToken: cRun.leaseToken! })).id))!;
    await expect(childGrant(dRun.id, dRun.leaseToken!, agents[2])).rejects.toThrow();
  });
  it('keeps the parent WORKING, releases its lease and resumes once after a parallel join', async () => {
    const parent = await root(); const b = await child(parent, 1); const c = await child(parent, 2);
    await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id, c.row.id]);
    await finishTask(parent.id, parent.leaseToken!, 3, undefined, textArtifact('Waiting for specialists'));
    expect(await getTaskRow(grant, parent.id)).toMatchObject({ phase: 'waiting', state: 2, leaseToken: null, resumeCount: 0 });
    const bRun = (await claimTask(b.row.id))!; await finishTask(bRun.id, bRun.leaseToken!, 3, undefined, textArtifact('Review result'));
    await reconcileLocalWaits(); expect((await getTaskRow(grant, parent.id)).phase).toBe('waiting');
    const cRun = (await claimTask(c.row.id))!; await finishTask(cRun.id, cRun.leaseToken!, 3, undefined, textArtifact('Test result'));
    await reconcileLocalWaits(); await reconcileLocalWaits();
    const resumed = (await claimTask(parent.id))!; expect(resumed.resumeCount).toBe(1); expect(resumed.leaseToken).not.toBe(parent.leaseToken);
    expect(await claimTask(parent.id)).toBeNull();
    expect(JSON.stringify(Task.fromJSON(resumed.snapshot).history.at(-1))).toContain('Review result');
    expect(JSON.stringify(Task.fromJSON(resumed.snapshot).history.at(-1))).toContain('Test result');
    await finishTask(parent.id, resumed.leaseToken!, 3, undefined, textArtifact('Combined report'));
    expect((await getTask(grant, parent.id)).status?.state).toBe(3);
    expect((await eventsAfter(grant, parent.id, 0)).length).toBeGreaterThan(4);
  });
  it('supports question → parent continuation → child continuation with the same task ID', async () => {
    const parent = await root(); const b = await child(parent);
    await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id]); await finishTask(parent.id, parent.leaseToken!, 3);
    const run = (await claimTask(b.row.id))!; await requestLocalInput(run.id, run.leaseToken!, 'Which branch?'); await finishTask(run.id, run.leaseToken!, 3);
    expect((await getTask(b.grant, run.id)).status?.state).toBe(6);
    await reconcileLocalWaits(); const resumed = (await claimTask(parent.id))!;
    const continuedGrant = await childGrant(parent.id, resumed.leaseToken!, agents[1]);
    const continued = await submitTask(continuedGrant, request('main', { taskId: run.id }), { parentLeaseToken: resumed.leaseToken! });
    expect(continued.id).toBe(run.id); expect(continued.deadlineAt).toEqual(run.deadlineAt);
    const next = (await claimTask(run.id))!; await finishTask(run.id, next.leaseToken!, 3, undefined, textArtifact('Reviewed main'));
    await finishTask(parent.id, resumed.leaseToken!, 3, undefined, textArtifact('Done'));
    expect((await getTask(grant, parent.id)).status?.state).toBe(3);
  });
  it('cannot turn an executor crash after requesting input or wait into a pause', async () => {
    const parent = await root(); await requestLocalInput(parent.id, parent.leaseToken!, 'More information?');
    await finishTask(parent.id, parent.leaseToken!, TaskState.TASK_STATE_FAILED, 'Executor failed');
    expect((await getTask(grant, parent.id)).status?.state).toBe(4);
  });
  it('automatically joins outstanding children when the parent ends its turn early', async () => {
    const parent = await root(); await child(parent);
    await finishTask(parent.id, parent.leaseToken!, 3, undefined, textArtifact('Submitted'));
    expect(await getTaskRow(grant, parent.id)).toMatchObject({ state: 2, phase: 'waiting', leaseToken: null });
  });
  it('rejects waiting on foreign, unrelated or self tasks', async () => {
    const parent = await root(); const other = await root(); const foreign = await child(other);
    await expect(requestLocalWait(parent.id, parent.leaseToken!, [foreign.row.id])).rejects.toThrow();
    await expect(requestLocalWait(parent.id, parent.leaseToken!, [parent.id])).rejects.toThrow();
  });
  it('cascades cancellation and never reports an active child stopped before acknowledgment', async () => {
    const parent = await root(); const b = await child(parent); const c = await child(parent, 2); const bRun = (await claimTask(b.row.id))!;
    await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id, c.row.id]); await finishTask(parent.id, parent.leaseToken!, 3);
    expect((await requestCancellation(grant, parent.id)).status?.state).toBe(5);
    expect(await db.a2ATask.findUnique({ where: { id: b.row.id } })).toMatchObject({ state: 2, cancelRequestedAt: expect.any(Date) });
    expect((await db.a2ATask.findUniqueOrThrow({ where: { id: c.row.id } })).state).toBe(5);
    await finishTask(bRun.id, bRun.leaseToken!, 3, undefined, textArtifact('must not publish'));
    expect(Task.fromJSON((await db.a2ATask.findUniqueOrThrow({ where: { id: b.row.id } })).snapshot).artifacts).toEqual([]);
  });
  it('revalidates actor, ancestor edges and configuration before resuming', async () => {
    const parent = await root(); const b = await child(parent);
    await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id]); await finishTask(parent.id, parent.leaseToken!, 3);
    await db.agentSubAgent.delete({ where: { parentId_childId: { parentId: agents[0], childId: agents[1] } } });
    await expect(assertLocalGrant(b.grant)).rejects.toThrow();
    await reconcileLocalWaits(); expect((await getTask(grant, parent.id)).status?.state).toBe(4);
    const fresh = await createLocalRootGrant(ws, agents[0], user);
    await db.user.update({ where: { id: user }, data: { status: 'suspended' } });
    await expect(assertLocalGrant(fresh)).rejects.toThrow();
  });
  it('does not let waiting renew the root deadline or inflate task budgets', async () => {
    const parent = await root(); const b = await child(parent);
    expect(b.row.deadlineAt.getTime()).toBeLessThanOrEqual(parent.deadlineAt.getTime());
    await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id]); await finishTask(parent.id, parent.leaseToken!, 3);
    await db.a2ATask.update({ where: { id: parent.id }, data: { deadlineAt: new Date(0) } });
    await reconcileLocalWaits(); expect((await getTask(grant, parent.id)).status?.state).toBe(4);
  });
  it('revokes task model/MCP credentials on suspension and prevents stale-lease publication', async () => {
    const parent = await root(); const token = runtimeToken(parent); await assertLocalRuntimeToken(token);
    expect(await isAgentRuntimeGrantCurrent(token)).toBe(true);
    const b = await child(parent); await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id]); await finishTask(parent.id, parent.leaseToken!, 3);
    await expect(assertLocalRuntimeToken(token)).rejects.toThrow(); expect(await isAgentRuntimeGrantCurrent(token)).toBe(false);
    await finishTask(parent.id, parent.leaseToken!, 3, undefined, textArtifact('stale result'));
    expect((await getTask(grant, parent.id)).artifacts).toEqual([]);
  });
  it('uses the official MCP client/transport with task-scoped credentials', async () => {
    const parent = await root(); const token = await createAgentRuntimeToken(runtimeToken(parent));
    const url = `https://toolplane.test/api/v1/agent-runtime/a2a/${parent.id}/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const req = new Request(input, init);
        return req.method === 'POST' ? handleLocalMcp(req, parent.id) : new Response(null, { status: 405 });
      } });
    const client = new Client({ name: 'local-a2a-test', version: '1' });
    try {
      await client.connect(transport); const tools = await client.listTools(); expect(tools.tools).toHaveLength(9);
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['a2a_list_remote_agents', 'a2a_send_remote_message']));
      const result = await client.callTool({ name: 'a2a_send_message', arguments: { agentId: agents[1], request: SendMessageRequest.toJSON(request()) } });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain('TASK_STATE_SUBMITTED'); expect(JSON.stringify(result)).not.toContain('fixture-secret');
    } finally { await client.close(); }
  });
  it('blocks ordinary runtime tokens and cross-task MCP access', async () => {
    const parent = await root(); const payload = runtimeToken(parent);
    const ordinary = { ...payload, a2aTaskId: undefined, a2aLeaseToken: undefined };
    await expect(executeLocalMcpTool(ordinary, 'a2a_list_agents', {})).rejects.toThrow();
    const token = await createAgentRuntimeToken(payload);
    const req = new Request('https://toolplane.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    expect((await handleLocalMcp(req, 'wrong-task')).status).toBe(401);
  });
  it('enforces a root-wide task count including completed child work', async () => {
    const parent = await root();
    for (let i = 1; i < LOCAL_LIMITS.tasksPerRoot; i++) {
      const b = await child(parent); const run = (await claimTask(b.row.id))!; await finishTask(run.id, run.leaseToken!, 3);
    }
    await expect(child(parent)).rejects.toThrow('capacity');
    expect(await db.a2ATask.count({ where: { rootTaskId: parent.id } })).toBe(LOCAL_LIMITS.tasksPerRoot);
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === '1')('atomically claims one parent continuation under PostgreSQL concurrency', async () => {
    const parent = await root(); const b = await child(parent); const run = (await claimTask(b.row.id))!; await finishTask(run.id, run.leaseToken!, 3);
    await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id]); await finishTask(parent.id, parent.leaseToken!, 3);
    const claimed = await Promise.all([claimTask(parent.id), claimTask(parent.id), claimTask(parent.id)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });
  it('runs a durable parent-child-parent cycle through the native Worker port', async () => {
    const initial = await submitTask(grant, request()); let childId = '';
    await executeA2ATask(initial.id, async (parent, signal) => {
      signal.throwIfAborted(); const b = await child(parent); childId = b.row.id;
      await requestLocalWait(parent.id, parent.leaseToken!, [childId]); return { state: 3, artifact: textArtifact('Delegated') };
    });
    await executeA2ATask(childId, async () => ({ state: 3, artifact: textArtifact('Specialist result') }));
    await reconcileLocalWaits();
    await executeA2ATask(initial.id, async (resumed) => {
      expect(Message.toJSON(Task.fromJSON(resumed.snapshot).history.at(-1)!)).toMatchObject({ role: 'ROLE_USER' });
      return { state: 3, artifact: textArtifact('Combined answer') };
    });
    expect((await getTask(grant, initial.id)).status?.state).toBe(3);
  });
  it('preserves waiting work across restart, but fails uncertain executing children instead of replaying them', async () => {
    const parent = await root(); const b = await child(parent); await claimTask(b.row.id);
    await requestLocalWait(parent.id, parent.leaseToken!, [b.row.id]); await finishTask(parent.id, parent.leaseToken!, 3);
    await startA2AWorker(); stopA2AWorker();
    expect(await getTaskRow(grant, parent.id)).toMatchObject({ state: 2, phase: 'waiting' });
    expect((await db.a2ATask.findUniqueOrThrow({ where: { id: b.row.id } })).state).toBe(4);
  });
  it('automatically rejoins a child question even when the parent forgot to explicitly await', async () => {
    const parent = await root(); const delegated = await child(parent);
    const executing = (await claimTask(delegated.row.id))!;
    await requestLocalInput(executing.id, executing.leaseToken!, 'Which branch?');
    await finishTask(executing.id, executing.leaseToken!, TaskState.TASK_STATE_COMPLETED);
    await finishTask(parent.id, parent.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('I delegated it.'));
    expect(await getTaskRow(grant, parent.id)).toMatchObject({ state: TaskState.TASK_STATE_WORKING, phase: 'resumable', leaseToken: null });
    const resumed = (await claimTask(parent.id))!;
    expect(JSON.stringify(resumed.snapshot)).toContain('Which branch?');
  });
  it('revalidates local authority before committing a successful executor result', async () => {
    const parent = await root();
    await db.agent.update({ where: { id: agents[0] }, data: { a2aInternalEnabled: false } });
    await expect(finishTask(parent.id, parent.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('late'))).rejects.toThrow();
    await finishTask(parent.id, parent.leaseToken!, TaskState.TASK_STATE_FAILED);
    expect((await db.a2ATask.findUniqueOrThrow({ where: { id: parent.id } })).state).toBe(TaskState.TASK_STATE_FAILED);
  });
  it('keeps a busy local sandbox task queued instead of failing or replaying it', async () => {
    // Reset the worker's stop flag without letting its timer run the fixture.
    await startA2AWorker();
    const queued = await submitTask(grant, request());
    let release!: () => void;
    const lock = withSandboxExecutionLease(sandboxes[0], () => new Promise<void>((resolve) => { release = resolve; }));
    const executor = vi.fn(async () => ({ state: TaskState.TASK_STATE_COMPLETED, artifact: textArtifact('done') }));
    try {
      await executeA2ATask(queued.id, executor);
      expect(executor).not.toHaveBeenCalled();
      expect(await getTaskRow(grant, queued.id)).toMatchObject({ state: TaskState.TASK_STATE_SUBMITTED, phase: 'queued', leaseToken: null });
    } finally { release(); await lock; }
    await executeA2ATask(queued.id, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect((await getTask(grant, queued.id)).status!.state).toBe(TaskState.TASK_STATE_COMPLETED);
    stopA2AWorker();
  });

});

describe('console task tree authorization', () => {
  const actor = () => ({ workspaceId: ws, actorId: user, agentId: agents[0], slug: 'unused' });
  it('shows owned root and descendants without execution grants or private prompts', async () => {
    const parent = await root(); const delegated = await child(parent);
    const tree = await getConsoleTaskTree(actor(), parent.id, delegated.row.id);
    expect(tree.nodes.map((n) => n.id)).toEqual([parent.id, delegated.row.id]);
    expect(tree.selectedTask).toMatchObject({ id: delegated.row.id, status: { state: 'TASK_STATE_SUBMITTED' } });
    expect(tree.selectedTask.history ?? []).toEqual([]);
    expect(tree.restricted).toBe(false);
    for (const value of [parent.leaseToken!, 'fixture-secret', 'targetBinding', 'ancestorAgentIds']) expect(JSON.stringify(tree)).not.toContain(value);
  });
  it('denies another member, foreign root and direct delegated entry', async () => {
    const parent = await root(); const delegated = await child(parent);
    await expect(getConsoleTaskTree({ ...actor(), actorId: otherUser }, parent.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(getConsoleTaskTree(actor(), delegated.row.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    const second = await root();
    await expect(getConsoleTaskTree(actor(), second.id, delegated.row.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('withholds a disabled child and its details while keeping the authorized root', async () => {
    const parent = await root(); const delegated = await child(parent);
    await db.agent.update({ where: { id: agents[1] }, data: { a2aInternalEnabled: false } });
    const tree = await getConsoleTaskTree(actor(), parent.id);
    expect(tree.nodes).toHaveLength(1); expect(tree.restricted).toBe(true);
    expect(JSON.stringify(tree)).not.toContain(delegated.row.id);
    await expect(getConsoleTaskTree(actor(), parent.id, delegated.row.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('uses current read authority, not an expired execution credential, for history', async () => {
    const parent = await root(); const delegated = await child(parent);
    await requestCancellation(grant, parent.id);
    await finishTask(parent.id, parent.leaseToken!, TaskState.TASK_STATE_CANCELED);
    const stored = await db.a2ATask.findUniqueOrThrow({ where: { id: delegated.row.id } });
    await db.a2ATask.update({ where: { id: stored.id }, data: { grant: { ...delegated.grant, expiresAt: 1 } } });
    expect((await getConsoleTaskTree(actor(), parent.id, stored.id)).selectedTask.id).toBe(stored.id);
  });
});


describe('scoped native task artifacts', () => {
  it('publishes standard JSON and binary artifacts atomically and makes retries idempotent', async () => {
    const task = await root();
    const data = { artifactId: 'report-v1', name: 'review.json', parts: [{ data: { z: 'last', a: 'first' } }] };
    await publishLocalArtifact(task.id, task.leaseToken!, data);
    const count = (await eventsAfter(grant, task.id, 0)).length;
    expect(await publishLocalArtifact(task.id, task.leaseToken!, { ...data, parts: [{ data: { a: 'first', z: 'last' } }] })).toMatchObject({ replay: true });
    expect((await eventsAfter(grant, task.id, 0)).length).toBe(count);
    await expect(publishLocalArtifact(task.id, task.leaseToken!, { ...data, parts: [{ text: 'changed' }] })).rejects.toThrow();
    await publishLocalArtifact(task.id, task.leaseToken!, { artifactId: 'patch-v1', name: 'fix.patch', parts: [{ raw: Buffer.from('diff --git').toString('base64'), mediaType: 'text/x-diff' }] });
    const wire = Task.toJSON(await getTask(grant, task.id)) as { artifacts: Array<{ parts: unknown[] }> };
    expect(wire.artifacts[0].parts[0]).toMatchObject({ data: { a: 'first', z: 'last' }, mediaType: 'application/json' });
    expect(wire.artifacts[1].parts[0]).toMatchObject({ raw: Buffer.from('diff --git').toString('base64'), mediaType: 'text/x-diff' });
    const reader = await createLocalRootGrant(ws, agents[0], otherUser);
    await expect(getTask(reader, task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('rejects stale execution leases and attempts to publish after suspension', async () => {
    const task = await root(); const data = { artifactId: 'x', name: 'report.txt', parts: [{ text: 'report' }] };
    await expect(publishLocalArtifact(task.id, 'stale', data)).rejects.toBeInstanceOf(TaskNotFoundError);
    await requestLocalInput(task.id, task.leaseToken!, 'Which branch?');
    await expect(publishLocalArtifact(task.id, task.leaseToken!, data)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
  it('honors caller output modes without guessing JSON from ordinary model text', async () => {
    const input = request(); input.configuration!.acceptedOutputModes = ['application/json'];
    const task = (await claimTask((await submitTask(grant, input)).id))!;
    await expect(publishLocalArtifact(task.id, task.leaseToken!, { artifactId: 'no', name: 'no.txt', parts: [{ text: 'not accepted' }] })).rejects.toThrow();
    await publishLocalArtifact(task.id, task.leaseToken!, { artifactId: 'yes', name: 'report.json', parts: [{ data: { ok: true } }] });
    await finishTask(task.id, task.leaseToken!, 3, undefined, textArtifact('Completed review'));
    const result = await getTask(grant, task.id); expect(result.status?.state).toBe(3);
    expect(result.artifacts).toHaveLength(1); expect(result.artifacts[0].artifactId).toBe('yes');
    const missing = (await claimTask((await submitTask(grant, { ...input, message: { ...input.message!, messageId: randomUUID() } })).id))!;
    await finishTask(missing.id, missing.leaseToken!, 3, undefined, textArtifact('{"not":"parsed"}'));
    expect((await getTask(grant, missing.id)).status?.state).toBe(4);
  });
});


describe('native daily workbench persistence', () => {
  it('lists only workspace navigation metadata and rechecks actor access', async () => {
    const found = await listWorkbenchAgents(ws, user);
    expect(found.map((item) => item.id)).toEqual(expect.arrayContaining(agents));
    expect(found.every((item) => item.enabled && item.configured)).toBe(true);
    expect(Object.keys(found[0]).sort()).toEqual(['configured', 'enabled', 'id', 'name', 'runtimeKind']);
    expect(JSON.stringify(found)).not.toContain('fixture-secret');
    await db.agent.update({ where: { id: agents[0] }, data: { a2aInternalEnabled: false } });
    expect((await listWorkbenchAgents(ws, otherUser)).find((item) => item.id === agents[0])?.enabled).toBe(false);
    await expect(listWorkbenchAgents('other-workspace', user)).rejects.toThrow();
    await db.user.update({ where: { id: user }, data: { status: 'suspended' } });
    await expect(listWorkbenchAgents(ws, user)).rejects.toThrow();
  });
  it('creates follow-ups in one context, retains the old terminal task and deduplicates retries', async () => {
    const first = await submitTask(grant, SendMessageRequest.fromJSON(workbenchMessage('Review', null, 'workbench-first')));
    const running = (await claimTask(first.id))!;
    await finishTask(first.id, running.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('First report'));
    const previous = await getTask(grant, first.id);
    const nextRequest = SendMessageRequest.fromJSON(workbenchMessage('Refine the report', previous, 'workbench-next'));
    const next = await submitTask(grant, nextRequest);
    const replay = await submitTask(grant, nextRequest);
    expect(next.id).not.toBe(first.id); expect(replay.id).toBe(next.id); expect(next.contextId).toBe(first.contextId);
    expect((await getTask(grant, first.id)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect((await getTask(grant, first.id)).artifacts).toEqual(previous.artifacts);
    expect(await db.conversation.count({ where: { agent: { workspaceId: ws } } })).toBe(0);
    expect(await db.workSession.count({ where: { workspaceId: ws } })).toBe(0);
  });
  it('answers an input-required task without renewing its deadline or replacing its task ID', async () => {
    const first = await root();
    await requestLocalInput(first.id, first.leaseToken!, 'Which branch?');
    await finishTask(first.id, first.leaseToken!, TaskState.TASK_STATE_COMPLETED);
    const waiting = await getTask(grant, first.id);
    expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const reply = SendMessageRequest.fromJSON(workbenchMessage('main', waiting, 'workbench-answer'));
    const continued = await submitTask(grant, reply);
    expect(continued.id).toBe(first.id); expect(continued.contextId).toBe(first.contextId); expect(continued.deadlineAt).toEqual(first.deadlineAt);
    expect((await submitTask(grant, reply)).id).toBe(first.id);
    const run = (await claimTask(first.id))!;
    await finishTask(run.id, run.leaseToken!, TaskState.TASK_STATE_COMPLETED, undefined, textArtifact('Reviewed main'));
    expect((await getTask(grant, first.id)).history.some((message) => message.parts.some((part) => part.content?.$case === 'text' && part.content.value === 'main'))).toBe(true);
  });
  it('returns bounded task history only through the authorized root and excludes it by default', async () => {
    const parent = await root(); const delegated = await child(parent);
    const actor = { workspaceId: ws, actorId: user, agentId: agents[0], slug: 'test' };
    expect((await getConsoleTaskTree(actor, parent.id)).selectedTask.history ?? []).toEqual([]);
    const viewed = await getConsoleTaskTree(actor, parent.id, parent.id, 32);
    expect(Task.fromJSON(viewed.selectedTask).history[0].parts[0].content?.value).toBe('Do this task');
    await expect(getConsoleTaskTree({ ...actor, actorId: otherUser }, parent.id, parent.id, 32)).rejects.toThrow();
    await expect(getConsoleTaskTree(actor, delegated.row.id, delegated.row.id, 32)).rejects.toThrow();
    await expect(getConsoleTaskTree(actor, parent.id, parent.id, 33)).rejects.toThrow();
  });
});
