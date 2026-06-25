// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import {
  listProviders,
  getAgentForRequest,
  getConversation,
} from '@/lib/agents/queries';

let workspaceId = '';
let userId = '';
let agentId = '';
let conversationId = '';

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `agents-q-${Date.now()}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const ws = await db.workspace.create({
    data: { slug: `agents-q-${Date.now()}`, name: 'Q', ownerId: userId,
      members: { create: { userId, role: 'owner' } } },
  });
  workspaceId = ws.id;
  await db.modelProvider.create({
    data: { workspaceId, name: 'OpenAI', format: 'openai',
      baseUrl: 'https://api.openai.com/v1', apiKey: 'k', models: ['gpt-x'] },
  });
  const agent = await db.agent.create({ data: { workspaceId, name: 'A', slug: 'a' } });
  agentId = agent.id;
  const conv = await db.conversation.create({ data: { agentId } });
  conversationId = conv.id;
  await db.message.create({
    data: { conversationId, role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('agents queries', () => {
  it('lists providers with their cached models', async () => {
    const providers = await listProviders(workspaceId);
    expect(providers[0].models).toContain('gpt-x');
  });

  it('loads an agent for an authorized user with tool relations', async () => {
    const agent = await getAgentForRequest(agentId, userId);
    expect(agent?.name).toBe('A');
    expect(Array.isArray(agent?.servers)).toBe(true);
    expect(await getAgentForRequest(agentId, 'someone-else')).toBeNull();
  });

  it('loads a conversation with messages scoped to the workspace', async () => {
    const conv = await getConversation(conversationId, workspaceId);
    expect(conv?.messages).toHaveLength(1);
    expect(await getConversation(conversationId, 'other-ws')).toBeNull();
  });
});
