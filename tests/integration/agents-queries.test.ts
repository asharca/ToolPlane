// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import {
  getAgentForRequest,
  getAgentPageData,
  getConversation,
  listAgentDeploymentOptions,
  listAgentSkillOptions,
  listProviders,
} from '@/lib/agents/queries';

let workspaceId = '';
let userId = '';
let agentId = '';
let conversationId = '';
let deploymentId = '';
let sandboxDeploymentId = '';
let installedSkillId = '';

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
  const deployment = await db.deployment.create({
    data: {
      workspaceId,
      name: 'Query MCP',
      source: 'custom',
      status: 'stopped',
      installCfg: { command: 'ignored-by-selector' },
    },
  });
  deploymentId = deployment.id;
  const sandboxDeployment = await db.deployment.create({
    data: { workspaceId, name: 'Sandbox MCP', source: 'sandbox', status: 'stopped' },
  });
  sandboxDeploymentId = sandboxDeployment.id;
  const installedSkill = await db.installedSkill.create({
    data: {
      workspaceId,
      name: 'Query Skill',
      slug: 'query-skill',
      content: '# Large artifact omitted from selector',
      files: { 'reference.md': 'artifact' },
      source: 'upload',
    },
  });
  installedSkillId = installedSkill.id;
  await db.agentSkill.create({ data: { agentId, installedSkillId } });
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

  it('loads only relation ids for the Agent settings page', async () => {
    const agent = await getAgentPageData(workspaceId, agentId);
    expect(agent?.skills).toEqual([{ installedSkillId }]);
    expect(agent?.skills[0]).not.toHaveProperty('installedSkill');
  });

  it('returns lightweight selectable resources and excludes sandbox deployments', async () => {
    const [deployments, skills] = await Promise.all([
      listAgentDeploymentOptions(workspaceId, new Set([deploymentId])),
      listAgentSkillOptions(workspaceId, new Set([installedSkillId])),
    ]);

    expect(deployments).toContainEqual(expect.objectContaining({
      id: deploymentId,
      label: 'Query MCP',
      checked: true,
    }));
    expect(deployments.some((deployment) => deployment.id === sandboxDeploymentId)).toBe(false);
    expect(deployments[0]).not.toHaveProperty('installCfg');
    expect(skills).toContainEqual(expect.objectContaining({
      id: installedSkillId,
      label: 'Query Skill',
      checked: true,
    }));
    expect(skills[0]).not.toHaveProperty('content');
    expect(skills[0]).not.toHaveProperty('files');
  });

  it('loads a conversation with messages scoped to the workspace', async () => {
    const conv = await getConversation(conversationId, workspaceId);
    expect(conv?.messages).toHaveLength(1);
    expect(await getConversation(conversationId, 'other-ws')).toBeNull();
  });
});
