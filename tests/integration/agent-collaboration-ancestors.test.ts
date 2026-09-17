// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
vi.mock('@/lib/agents/sandbox-turn', () => ({ runDedicatedSandboxTurn: vi.fn() }));
import { openCollaborationRun, closeCollaborationRun, submitDelegation } from '@/lib/agents/collaboration/service';
import { processCollaborationTask, stopCollaborationCoordinator } from '@/lib/agents/collaboration/worker';

let workspaceId: string, userId: string, providerId: string;
const agents: Array<{ id: string; sandboxId: string }> = [];
beforeAll(async () => {
  const stamp = randomUUID();
  userId = (await db.user.create({ data: { email: `${stamp}@ancestor.test`, passwordHash: 'fixture' } })).id;
  workspaceId = (await db.workspace.create({ data: { name: 'Ancestor authority', slug: `ancestor-${stamp}`, ownerId: userId } })).id;
  providerId = (await db.modelProvider.create({ data: { workspaceId, name: 'Fixture', format: 'openai',
    baseUrl: 'https://models.invalid', apiKey: 'fixture-only', models: ['fixture-model'] } })).id;
  for (const runtimeKind of ['pi', 'claude-code', 'hermes-rpc']) {
    const id = randomUUID();
    const deployment = await db.deployment.create({ data: { workspaceId, name: id, source: 'sandbox', status: 'running' } });
    const sandbox = await db.sandbox.create({ data: { workspaceId, name: id, slug: id, kind: 'docker', network: 'isolated', deploymentId: deployment.id } });
    await db.agent.create({ data: { id, workspaceId, name: id, slug: id, runtimeKind, providerId, model: 'fixture-model',
      sandboxes: { create: { sandboxId: sandbox.id, isDefault: true } } } });
    agents.push({ id, sandboxId: sandbox.id });
  }
  await db.agentSubAgent.createMany({ data: [
    { parentId: agents[0].id, childId: agents[1].id }, { parentId: agents[1].id, childId: agents[2].id },
  ] });
});
afterAll(async () => {
  stopCollaborationCoordinator();
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

it('revokes live descendants when a completed ancestor loses its delegation edge', async () => {
  const root = await openCollaborationRun({ workspaceId, agentId: agents[0].id, sandboxId: agents[0].sandboxId,
    providerId, targetIds: [agents[1].id] });
  const actor = { kind: 'runtime' as const, workspaceId, agentId: agents[0].id, runId: root.id };
  const parent = await submitDelegation(actor, { agentId: agents[1].id, messageId: randomUUID(), message: 'Review.' });
  await db.agentCollaborationTask.update({ where: { id: parent.id }, data: { state: 'working' } });
  const child = await openCollaborationRun({ workspaceId, agentId: agents[1].id, sandboxId: agents[1].sandboxId,
    providerId, targetIds: [agents[2].id], taskId: parent.id, conversationId: parent.contextId });
  const nested = await submitDelegation({ kind: 'runtime', workspaceId, agentId: agents[1].id, runId: child.id },
    { agentId: agents[2].id, messageId: randomUUID(), message: 'Inspect a detail.' });
  await closeCollaborationRun(child.id);
  await db.agentCollaborationTask.update({ where: { id: parent.id }, data: { state: 'completed', completedAt: new Date() } });
  await db.agentSubAgent.delete({ where: { parentId_childId: { parentId: agents[0].id, childId: agents[1].id } } });
  const execute = vi.fn(async () => ({ text: 'must not run' }));
  await processCollaborationTask(nested.id, execute);
  expect(execute).not.toHaveBeenCalled();
  const result = await db.agentCollaborationTask.findUniqueOrThrow({ where: { id: nested.id } });
  expect(result.state).toBe('failed');
  expect(result.errorCode).toBe('ancestor_revoked');
});
