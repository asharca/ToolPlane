// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import {
  createAgent,
  updateAgent,
  setAgentTools,
  setProviderModels,
  appendMessage,
  createConversation,
} from '@/lib/agents/mutations';

let workspaceId = '';
let userId = '';
let deploymentId = '';
let providerId = '';

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `agents-m-${Date.now()}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const ws = await db.workspace.create({
    data: { slug: `agents-m-${Date.now()}`, name: 'M', ownerId: userId,
      members: { create: { userId, role: 'owner' } } },
  });
  workspaceId = ws.id;
  const server = await db.server.create({
    data: { slug: `srv-${Date.now()}`, name: 'Srv' },
  });
  const dep = await db.deployment.create({ data: { workspaceId, serverId: server.id } });
  deploymentId = dep.id;
  const provider = await db.modelProvider.create({
    data: { workspaceId, name: 'P', format: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' },
  });
  providerId = provider.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('agents mutations', () => {
  it('creates an agent with a unique slug', async () => {
    const a = await createAgent(workspaceId, 'My Agent');
    expect(a.slug).toBe('my-agent');
    const b = await createAgent(workspaceId, 'My Agent');
    expect(b.slug).toBe('my-agent-1');
  });

  it('updates config and replaces the attached tools', async () => {
    const a = await createAgent(workspaceId, 'Cfg');
    await updateAgent(workspaceId, a.id, {
      name: 'Cfg2', systemPrompt: 'sp', providerId, model: 'gpt-x', maxSteps: 5,
    });
    await setAgentTools(workspaceId, a.id, {
      deploymentIds: [deploymentId], installedSkillIds: [], toolkitIds: [],
    });
    const reread = await db.agent.findUnique({
      where: { id: a.id }, include: { servers: true },
    });
    expect(reread?.name).toBe('Cfg2');
    expect(reread?.model).toBe('gpt-x');
    expect(reread?.servers).toHaveLength(1);

    await setAgentTools(workspaceId, a.id, { deploymentIds: [], installedSkillIds: [], toolkitIds: [] });
    const after = await db.agent.findUnique({ where: { id: a.id }, include: { servers: true } });
    expect(after?.servers).toHaveLength(0);
  });

  it('caches provider models', async () => {
    await setProviderModels(workspaceId, providerId, ['gpt-x', 'gpt-y']);
    const p = await db.modelProvider.findUnique({ where: { id: providerId } });
    expect(p?.models).toEqual(['gpt-x', 'gpt-y']);
    expect(p?.modelsFetchedAt).toBeInstanceOf(Date);
  });

  it('creates a conversation and appends messages', async () => {
    const a = await createAgent(workspaceId, 'Chat');
    const conv = await createConversation(a.id);
    await appendMessage(conv.id, 'user', [{ type: 'text', text: 'hi' }]);
    const msgs = await db.message.findMany({ where: { conversationId: conv.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });
});
