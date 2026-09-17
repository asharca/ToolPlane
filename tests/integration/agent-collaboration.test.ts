// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
vi.mock('@/lib/agents/sandbox-turn', () => ({ runDedicatedSandboxTurn: vi.fn() }));
import {
  openCollaborationRun, closeCollaborationRun, listDelegateAgents, submitDelegation,
  getDelegation, continueDelegation, decideDelegation, cancelDelegation, updateCurrentTask,
  assertCollaborationContext, type CollaborationPrincipal,
} from '@/lib/agents/collaboration/service';
import { processCollaborationTask, tickCollaboration, stopCollaborationCoordinator, startCollaborationCoordinator, pruneCollaborationHistory } from '@/lib/agents/collaboration/worker';
import { isAgentRuntimeGrantCurrent } from '@/lib/agents/runtime-grant';
import { createAgentRuntimeToken, verifyAgentRuntimeToken } from '@/lib/agents/runtime-access';

let ws: string, foreign: string, user: string, provider: string;
const agents: Array<{ id: string; sandboxId: string; runtime: string }> = [];
let sourceContext: string;
let actor: Extract<CollaborationPrincipal, { kind: 'runtime' }>;
const message = (agentId = agents[1].id) => ({ agentId, messageId: randomUUID(), message: 'Review this task.' });
const manager = () => ({ kind: 'user' as const, workspaceId: ws, agentId: agents[0].id, userId: user });
async function run(index = 0, options: { taskId?: string; conversationId?: string; workSessionId?: string } = {}) {
  const agent = agents[index];
  const value = await openCollaborationRun({ workspaceId: ws, agentId: agent.id, sandboxId: agent.sandboxId, providerId: provider,
    conversationId: options.conversationId ?? (index === 0 ? sourceContext : undefined),
    targetIds: agents.map((a) => a.id), ...options });
  return { kind: 'runtime' as const, workspaceId: ws, agentId: agent.id, runId: value.id };
}

beforeAll(async () => {
  const stamp = randomUUID();
  user = (await db.user.create({ data: { email: `${stamp}@collaboration.test`, passwordHash: 'fixture' } })).id;
  ws = (await db.workspace.create({ data: { name: 'Collaboration', slug: `collab-${stamp}`, ownerId: user,
    members: { create: { userId: user, role: 'owner' } } } })).id;
  foreign = (await db.workspace.create({ data: { name: 'Other', slug: `other-${stamp}`, ownerId: user } })).id;
  provider = (await db.modelProvider.create({ data: { workspaceId: ws, name: 'Fixture', format: 'openai',
    baseUrl: 'https://models.invalid', apiKey: 'never-export-this-key', models: ['fixture-model'] } })).id;
  for (const runtime of ['pi', 'claude-code', 'dsh', 'hermes-rpc', 'pi']) {
    const id = randomUUID();
    const deployment = await db.deployment.create({ data: { workspaceId: ws, name: `Sandbox ${id}`, source: 'sandbox', status: 'running' } });
    const sandbox = await db.sandbox.create({ data: { workspaceId: ws, name: id, slug: id, kind: 'docker', network: 'isolated', deploymentId: deployment.id } });
    await db.agent.create({ data: { id, workspaceId: ws, name: runtime, slug: id, runtimeKind: runtime,
      providerId: provider, model: 'fixture-model', systemPrompt: 'Private system prompt.',
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } } } });
    agents.push({ id, sandboxId: sandbox.id, runtime });
  }
  for (const a of agents) for (const b of agents) if (a.id !== b.id) await db.agentSubAgent.create({ data: { parentId: a.id, childId: b.id } });
});
beforeEach(async () => {
  await db.agentCollaborationRun.deleteMany({ where: { workspaceId: ws } });
  await db.workSession.deleteMany({ where: { workspaceId: ws } });
  await db.conversation.deleteMany({ where: { agent: { workspaceId: ws } } });
  sourceContext = (await db.conversation.create({ data: { agentId: agents[0].id } })).id;
  actor = await run();
});
afterAll(async () => {
  stopCollaborationCoordinator();
  await db.workspace.deleteMany({ where: { id: { in: [ws, foreign] } } });
  await db.user.delete({ where: { id: user } });
  await db.$disconnect();
});

describe('durable Agent collaboration', () => {
  it('lists only bound same-workspace Agents without prompts, keys or internal configuration', async () => {
    const listed = await listDelegateAgents(actor);
    expect(listed).toHaveLength(4);
    const json = JSON.stringify(listed);
    expect(json).not.toContain('never-export'); expect(json).not.toContain('Private system prompt');
    expect(listed.map((a) => a.runtimeKind)).toContain('hermes-rpc');
    await expect(submitDelegation(actor, message(agents[0].id))).rejects.toMatchObject({ code: 'not_found' });
    const other = await db.agent.create({ data: { workspaceId: foreign, name: 'Hidden', slug: 'hidden', runtimeKind: 'pi' } });
    await expect(submitDelegation(actor, message(other.id))).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.agentCollaborationTask.count({ where: { workspaceId: ws } })).toBe(0);
  });
  it('fails descendants closed when a root grant is deleted', async () => {
    const task = await submitDelegation(actor, message());
    await db.agentCollaborationTask.update({ where: { id: task.id }, data: { state: 'working' } });
    const child = await run(1, { taskId: task.id, conversationId: task.contextId });
    const nested = await submitDelegation(child, message(agents[2].id));
    await db.agentCollaborationRun.delete({ where: { id: actor.runId } });
    const execute = vi.fn(async () => ({ text: 'must not run' }));
    await processCollaborationTask(nested.id, execute);
    expect(execute).not.toHaveBeenCalled();
    expect((await db.agentCollaborationTask.findUniqueOrThrow({ where: { id: nested.id } })).state).toBe('failed');
  });
  it('invalidates accepted tasks when selected Skill contents change', async () => {
    const skill = await db.installedSkill.create({ data: { workspaceId: ws, name: 'Review', slug: 'review', content: 'First version' } });
    await db.agentSkill.create({ data: { agentId: agents[1].id, installedSkillId: skill.id } });
    const task = await submitDelegation(actor, message());
    await db.installedSkill.update({ where: { id: skill.id }, data: { content: 'Different behavior' } });
    const execute = vi.fn(async () => ({ text: 'must not run' }));
    await processCollaborationTask(task.id, execute);
    expect(execute).not.toHaveBeenCalled();
    expect((await getDelegation(actor, task.id)).status.errorCode).toBe('configuration_changed');
    await db.installedSkill.delete({ where: { id: skill.id } });
  });
  it('reserves deeper execution slots while first-level tasks wait for children', async () => {
    const tasks = await Promise.all([1, 2, 4].map((index) => submitDelegation(actor, message(agents[index].id))));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let firstReady!: () => void, secondReady!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondStarted = new Promise<void>((resolve) => { secondReady = resolve; });
    let childTaskId = '';
    const first = processCollaborationTask(tasks[0].id, async (claimed) => {
      const child = await run(1, { taskId: claimed.id, conversationId: claimed.contextId });
      childTaskId = (await submitDelegation(child, message(agents[3].id))).id;
      await closeCollaborationRun(child.runId);
      firstReady(); await hold; return { text: 'parent done' };
    });
    const second = processCollaborationTask(tasks[1].id, async () => { secondReady(); await hold; return { text: 'parent done' }; });
    try {
      await Promise.all([firstStarted, secondStarted]);
      const blocked = vi.fn(async () => ({ text: 'first level full' }));
      await processCollaborationTask(tasks[2].id, blocked); expect(blocked).not.toHaveBeenCalled();
      const deeper = vi.fn(async () => ({ text: 'child result' }));
      await processCollaborationTask(childTaskId, deeper); expect(deeper).toHaveBeenCalledOnce();
      expect((await db.agentCollaborationTask.findUniqueOrThrow({ where: { id: childTaskId } })).state).toBe('completed');
    } finally { release(); await Promise.all([first, second]); }
  });
  it('reserves the target task conversation against direct execution', async () => {
    const task = await submitDelegation(actor, message());
    await expect(assertCollaborationContext(task.contextId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(assertCollaborationContext(task.contextId, task.id)).resolves.toBeUndefined();
    await expect(assertCollaborationContext(sourceContext)).resolves.toBeUndefined();
  });
  it('enforces the per-root admission budget independently of model instructions', async () => {
    await db.agentCollaborationRun.update({ where: { id: actor.runId }, data: { taskCount: 16 } });
    await expect(submitDelegation(actor, message())).rejects.toMatchObject({ code: 'conflict' });
    expect(await db.agentCollaborationTask.count({ where: { runId: actor.runId } })).toBe(0);
  });
  it('expires waiting tasks without running them', async () => {
    const task = await submitDelegation(actor, message());
    await db.agentCollaborationTask.update({ where: { id: task.id }, data: { deadlineAt: new Date(Date.now() - 1) } });
    const execute = vi.fn(async () => ({ text: 'must not run' }));
    await processCollaborationTask(task.id, execute);
    expect(execute).not.toHaveBeenCalled();
    expect((await getDelegation(actor, task.id)).status.errorCode).toBe('deadline_exceeded');
  });
  it('prunes only expired terminal trees and their reserved contexts', async () => {
    const task = await submitDelegation(actor, message());
    await processCollaborationTask(task.id, async () => ({ text: 'done' }));
    await closeCollaborationRun(actor.runId);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await db.agentCollaborationRun.update({ where: { id: actor.runId }, data: { closedAt: old, deadlineAt: old } });
    await pruneCollaborationHistory();
    expect(await db.agentCollaborationTask.count({ where: { id: task.id } })).toBe(0);
    expect(await db.conversation.count({ where: { id: task.contextId } })).toBe(0);
    expect(await db.conversation.count({ where: { id: sourceContext } })).toBe(1);
  });
  it('deduplicates immutable message IDs, including a new invocation of the same caller conversation', async () => {
    const input = message();
    const first = await submitDelegation(actor, input);
    expect((await submitDelegation(actor, input)).id).toBe(first.id);
    await expect(submitDelegation(actor, { ...input, message: 'Changed' })).rejects.toMatchObject({ code: 'conflict' });
    await closeCollaborationRun(actor.runId);
    await expect(submitDelegation(actor, input)).rejects.toMatchObject({ code: 'expired_grant' });
    actor = await run();
    expect((await submitDelegation(actor, input)).id).toBe(first.id);
    expect(await db.agentCollaborationTask.count({ where: { workspaceId: ws } })).toBe(1);
    const otherContext = (await db.conversation.create({ data: { agentId: agents[0].id } })).id;
    await expect(getDelegation(await run(0, { conversationId: otherContext }), first.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it.each([1, 2, 3])('executes target runtime index %s as a durable task without replaying a completed task', async (index) => {
    const task = await submitDelegation(actor, message(agents[index].id));
    const execute = vi.fn(async () => ({ text: 'Completed review', usage: { input: 10, output: 4 } }));
    await processCollaborationTask(task.id, execute);
    expect((await getDelegation(actor, task.id)).status.state).toBe('completed');
    expect((await getDelegation(actor, task.id)).result).toBe('Completed review');
    await processCollaborationTask(task.id, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await db.message.count({ where: { conversationId: task.contextId } })).toBe(2);
    await expect(continueDelegation(actor, { taskId: task.id, messageId: randomUUID(), message: 'Redo' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('commits input-required only at clean completion, then resumes the same task context', async () => {
    const task = await submitDelegation(actor, message());
    await processCollaborationTask(task.id, async (claimed) => {
      const child = await run(1, { taskId: claimed.id, conversationId: claimed.contextId });
      await updateCurrentTask(child, { question: 'Which branch?' });
      expect((await getDelegation(actor, task.id)).status.state).toBe('working');
      await updateCurrentTask(child, { artifactId: 'notes', name: 'Review notes', text: 'Initial findings.' });
      await closeCollaborationRun(child.runId);
      return { text: 'Please provide a branch.' };
    });
    expect((await getDelegation(actor, task.id)).status.state).toBe('input-required');
    const input = { taskId: task.id, messageId: randomUUID(), message: 'Use main.' };
    expect((await continueDelegation(actor, input)).status.state).toBe('submitted');
    expect((await continueDelegation(actor, input)).id).toBe(task.id);
    await processCollaborationTask(task.id, async () => ({ text: 'Reviewed main.' }));
    const completed = await getDelegation(actor, task.id);
    expect(completed.status.state).toBe('completed'); expect(completed.contextId).toBe(task.contextId);
    expect(completed.artifacts).toEqual([{ artifactId: 'notes', name: 'Review notes', text: 'Initial findings.' }]);
    expect(await db.message.count({ where: { conversationId: task.contextId } })).toBe(4);
  });
  it('preserves failed status without recording raw exception content as a successful reply', async () => {
    const task = await submitDelegation(actor, message());
    await processCollaborationTask(task.id, async () => { throw new Error('API key secret-fixture and private content'); });
    const value = await getDelegation(actor, task.id);
    expect(value.status).toMatchObject({ state: 'failed', errorCode: 'execution_failed' });
    expect(value.result).toBeNull(); expect(JSON.stringify(value)).not.toContain('secret-fixture');
    expect(await db.message.count({ where: { conversationId: task.contextId } })).toBe(0);
  });
  it('requires explicit human authorization for Work-origin delegations', async () => {
    const context = await db.conversation.create({ data: { agentId: agents[0].id } });
    const work = await db.workSession.create({ data: { workspaceId: ws, agentId: agents[0].id, sandboxId: agents[0].sandboxId,
      runtimeKind: 'pi', conversationId: context.id, status: 'running' } });
    const workActor = await run(0, { conversationId: context.id, workSessionId: work.id });
    const task = await submitDelegation(workActor, message());
    expect(task.status.state).toBe('auth-required');
    const execute = vi.fn(async () => ({ text: 'authorized result' }));
    await processCollaborationTask(task.id, execute); expect(execute).not.toHaveBeenCalled();
    await decideDelegation(manager(), task.id, true);
    expect(await db.auditEvent.count({ where: { targetId: task.id, action: 'agent.collaboration.authorize', actorId: user } })).toBe(1);
    await processCollaborationTask(task.id, execute); expect(execute).toHaveBeenCalledOnce();
    expect((await getDelegation(workActor, task.id)).status.state).toBe('completed');
  });
  it('rejects a task after configuration changes instead of silently broadening tools', async () => {
    const task = await submitDelegation(actor, message());
    await db.agent.update({ where: { id: agents[1].id }, data: { maxSteps: 99 } });
    const execute = vi.fn(async () => ({ text: 'must not run' }));
    await processCollaborationTask(task.id, execute);
    expect(execute).not.toHaveBeenCalled();
    expect((await getDelegation(actor, task.id)).status.errorCode).toBe('configuration_changed');
    await db.agent.update({ where: { id: agents[1].id }, data: { maxSteps: 100 } });
  });
  it('revokes caller access when its delegation edge is removed', async () => {
    const task = await submitDelegation(actor, message());
    await db.agentSubAgent.delete({ where: { parentId_childId: { parentId: agents[0].id, childId: agents[1].id } } });
    await expect(getDelegation(actor, task.id)).rejects.toMatchObject({ code: 'not_found' });
    await processCollaborationTask(task.id, async () => ({ text: 'must not run' }));
    expect((await getDelegation(manager(), task.id)).status.state).toBe('failed');
    await db.agentSubAgent.create({ data: { parentId: agents[0].id, childId: agents[1].id } });
  });
  it('cancels queued tasks without starting them', async () => {
    const task = await submitDelegation(actor, message());
    expect((await cancelDelegation(actor, task.id)).status.state).toBe('canceled');
    const execute = vi.fn(async () => ({ text: 'must not run' }));
    await processCollaborationTask(task.id, execute); expect(execute).not.toHaveBeenCalled();
  });
  it('propagates cancellation and distinguishes the request from runtime settlement', async () => {
    const task = await submitDelegation(actor, message());
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = processCollaborationTask(task.id, async (_task, signal) => {
      started();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return { text: 'must not publish' };
    });
    await ready;
    const canceled = await cancelDelegation(actor, task.id);
    expect(canceled.status.state).toBe('working'); expect(canceled.cancelRequested).toBe(true);
    await tickCollaboration(); await pending;
    expect((await getDelegation(actor, task.id)).status.state).toBe('canceled');
    expect((await getDelegation(actor, task.id)).result).toBeNull();
  });
  it('tracks nested ancestry and refuses cycles using server-owned chain state', async () => {
    const task = await submitDelegation(actor, message());
    await processCollaborationTask(task.id, async (claimed) => {
      const child = await run(1, { taskId: claimed.id, conversationId: claimed.contextId });
      await expect(submitDelegation(child, message(agents[0].id))).rejects.toMatchObject({ code: 'cycle' });
      const nested = await submitDelegation(child, message(agents[2].id));
      const row = await db.agentCollaborationTask.findUniqueOrThrow({ where: { id: nested.id } });
      expect(row.ancestorTaskIds).toEqual([task.id]);
      expect(row.rootId).toBe((await db.agentCollaborationRun.findUniqueOrThrow({ where: { id: actor.runId } })).rootId);
      await cancelDelegation(actor, task.id);
      expect((await db.agentCollaborationTask.findUniqueOrThrow({ where: { id: nested.id } })).state).toBe('canceled');
      await closeCollaborationRun(child.runId);
      return { text: 'canceled' };
    });
  });
  it('expires run grants and keeps the claim in the signed token', async () => {
    const claims = { workspaceId: ws, agentId: agents[0].id, sandboxId: agents[0].sandboxId,
      providerId: provider, deploymentIds: [], collaborationRunId: actor.runId, exp: Math.floor(Date.now()/1000)+120 };
    const jwt = await createAgentRuntimeToken(claims);
    expect((await verifyAgentRuntimeToken(jwt))?.collaborationRunId).toBe(actor.runId);
    expect(await isAgentRuntimeGrantCurrent(claims)).toBe(true);
    await closeCollaborationRun(actor.runId);
    expect(await isAgentRuntimeGrantCurrent(claims)).toBe(false);
  });
  it('does not replay interrupted work on restart', async () => {
    const task = await submitDelegation(actor, message());
    await db.agentCollaborationTask.update({ where: { id: task.id }, data: { state: 'working' } });
    await startCollaborationCoordinator();
    expect((await getDelegation(manager(), task.id)).status).toMatchObject({ state: 'failed', errorCode: 'interrupted' });
  });
  it.skipIf(process.env.TOOLPLANE_TEST_PGLITE === '1')('serializes simultaneous duplicate submissions in real PostgreSQL', async () => {
    const input = message();
    const values = await Promise.all(Array.from({ length: 5 }, () => submitDelegation(actor, input)));
    expect(new Set(values.map((value) => value.id)).size).toBe(1);
  });
});
