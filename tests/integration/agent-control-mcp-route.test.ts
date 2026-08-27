// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { POST } from '@/app/api/v1/workspaces/[slug]/agents/mcp/route';

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let ownerId = '';
let memberId = '';
let outsiderId = '';
let workspaceId = '';
let workspaceSlug = '';
let providerId = '';
let messageAgentId = '';
let otherAgentConversationId = '';
let foreignWorkspaceId = '';
let foreignProviderId = '';
let foreignAgentId = '';
let createAgentSandboxId = '';
let invalidProviderSandboxId = '';
let ownerToken = '';
let memberToken = '';
let outsiderToken = '';
let toolkitToken = '';

async function createDockerSandbox(workspaceId: string, label: string) {
  const deployment = await db.deployment.create({
    data: { workspaceId, name: label, source: 'sandbox', status: 'stopped' },
  });
  return db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: deployment.id,
      name: label,
      slug: `${label.toLowerCase().replaceAll(' ', '-')}-${stamp}`,
      kind: 'docker',
      network: 'isolated',
    },
  });
}

beforeAll(async () => {
  const owner = await db.user.create({
    data: { email: `control-route-owner-${stamp}@test.dev`, passwordHash: 'x' },
  });
  ownerId = owner.id;
  workspaceSlug = `control-route-${stamp}`;
  const workspace = await db.workspace.create({
    data: {
      slug: workspaceSlug,
      name: 'Control route',
      ownerId,
      members: { create: { userId: ownerId, role: 'owner' } },
    },
  });
  workspaceId = workspace.id;
  const provider = await db.modelProvider.create({
    data: {
      workspaceId,
      name: 'Route provider',
      format: 'openai',
      baseUrl: 'https://route.invalid/v1',
      apiKey: 'ROUTE_SECRET_API_KEY',
      models: ['route-model'],
    },
  });
  providerId = provider.id;
  createAgentSandboxId = (await createDockerSandbox(workspaceId, 'Route agent sandbox')).id;
  invalidProviderSandboxId = (await createDockerSandbox(workspaceId, 'Invalid provider sandbox')).id;
  const messageAgent = await db.agent.create({
    data: {
      workspaceId,
      name: 'Message target',
      slug: `message-target-${stamp}`,
      runtimeKind: 'pi',
      providerId,
      model: 'route-model',
    },
  });
  messageAgentId = messageAgent.id;
  const otherAgent = await db.agent.create({
    data: { workspaceId, name: 'Other message agent', slug: `other-message-${stamp}`, runtimeKind: 'pi' },
  });
  const otherConversation = await db.conversation.create({ data: { agentId: otherAgent.id } });
  otherAgentConversationId = otherConversation.id;
  const toolkit = await db.toolkit.create({
    data: { workspaceId, name: 'Scoped kit', slug: `scoped-kit-${stamp}` },
  });
  ownerToken = (await createApiToken(ownerId, 'Agent control')).token;
  toolkitToken = (await createApiToken(ownerId, 'Toolkit only', { toolkitId: toolkit.id })).token;

  const member = await db.user.create({
    data: { email: `control-route-member-${stamp}@test.dev`, passwordHash: 'x' },
  });
  memberId = member.id;
  await db.membership.create({ data: { workspaceId, userId: memberId, role: 'member' } });
  memberToken = (await createApiToken(memberId, 'Member control')).token;

  const outsider = await db.user.create({
    data: { email: `control-route-outsider-${stamp}@test.dev`, passwordHash: 'x' },
  });
  outsiderId = outsider.id;
  const foreignWorkspace = await db.workspace.create({
    data: {
      slug: `control-route-foreign-${stamp}`,
      name: 'Foreign route',
      ownerId: outsiderId,
      members: { create: { userId: outsiderId, role: 'owner' } },
    },
  });
  foreignWorkspaceId = foreignWorkspace.id;
  const foreignProvider = await db.modelProvider.create({
    data: {
      workspaceId: foreignWorkspaceId,
      name: 'Foreign route provider',
      format: 'openai',
      baseUrl: 'https://foreign-route.invalid/v1',
      apiKey: 'foreign',
    },
  });
  foreignProviderId = foreignProvider.id;
  const foreignAgent = await db.agent.create({
    data: {
      workspaceId: foreignWorkspaceId,
      name: 'Foreign route agent',
      slug: `foreign-route-agent-${stamp}`,
      runtimeKind: 'pi',
    },
  });
  foreignAgentId = foreignAgent.id;
  outsiderToken = (await createApiToken(outsiderId, 'Outsider')).token;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.workspace.delete({ where: { id: foreignWorkspaceId } });
  await db.user.delete({ where: { id: ownerId } });
  await db.user.delete({ where: { id: memberId } });
  await db.user.delete({ where: { id: outsiderId } });
  await db.$disconnect();
});

function rpcRequest(
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
  origin?: string,
) {
  return new Request(`http://localhost/api/v1/workspaces/${workspaceSlug}/agents/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function call(token: string | null, name: string, args: Record<string, unknown> = {}) {
  return rpcRequest(token, 'tools/call', { name, arguments: args });
}

function invoke(request: Request) {
  return POST(request, { params: Promise.resolve({ slug: workspaceSlug }) });
}

describe('Agent Control MCP route authorization and creation', () => {
  it('requires auth, rejects toolkit tokens, hides the workspace from outsiders, and permits members', async () => {
    const unauthenticated = await invoke(rpcRequest(null, 'tools/list'));
    expect(unauthenticated.status).toBe(401);

    const scoped = await invoke(rpcRequest(toolkitToken, 'tools/list'));
    expect(scoped.status).toBe(401);

    const outsider = await invoke(rpcRequest(outsiderToken, 'tools/list'));
    expect(outsider.status).toBe(404);

    const member = await invoke(rpcRequest(memberToken, 'tools/list'));
    expect(member.status).toBe(200);
  });

  it('rejects cross-origin browser requests while allowing a same-origin Bearer client', async () => {
    const crossOrigin = await invoke(rpcRequest(
      ownerToken,
      'tools/list',
      undefined,
      'https://attacker.example',
    ));
    expect(crossOrigin.status).toBe(403);

    const sameOrigin = await invoke(rpcRequest(
      ownerToken,
      'tools/list',
      undefined,
      'http://localhost',
    ));
    expect(sameOrigin.status).toBe(200);
  });

  it('creates a configured agent through JSON-RPC without exposing its provider secret', async () => {
    const response = await invoke(call(ownerToken, 'create_agent', {
      name: 'Route-created agent',
      runtime: 'pi',
      providerId,
      model: 'route-model',
      systemPrompt: 'Be concise.',
      sandboxIds: [createAgentSandboxId],
    }));
    const body = await response.json();
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.result.agent).toMatchObject({
      name: 'Route-created agent',
      configured: true,
      ready: true,
    });
    expect(JSON.stringify(body)).not.toContain('ROUTE_SECRET_API_KEY');
    expect(JSON.stringify(body)).not.toContain('route.invalid');
    await expect(db.agent.count({
      where: { workspaceId, name: 'Route-created agent' },
    })).resolves.toBe(1);
  });

  it('rejects a provider from another workspace and leaves no partial agent', async () => {
    const before = await db.agent.count({ where: { workspaceId } });
    const response = await invoke(call(ownerToken, 'create_agent', {
      name: 'Must not persist',
      runtime: 'pi',
      providerId: foreignProviderId,
      model: 'foreign-model',
      sandboxIds: [invalidProviderSandboxId],
    }));
    const body = await response.json();
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'invalid_arguments' } },
    });
    await expect(db.agent.count({ where: { workspaceId } })).resolves.toBe(before);
  });

  it('does not invoke an agent from another workspace', async () => {
    const response = await invoke(call(ownerToken, 'send_message_to_agent', {
      agentId: foreignAgentId,
      message: 'Do not run',
    }));
    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: 'not_found' } },
      },
    });
  });

  it('does not accept a conversation belonging to another agent', async () => {
    const response = await invoke(call(ownerToken, 'send_message_to_agent', {
      agentId: messageAgentId,
      conversationId: otherAgentConversationId,
      message: 'Do not append this',
    }));
    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: 'not_found' } },
      },
    });
    await expect(db.message.count({ where: { conversationId: otherAgentConversationId } }))
      .resolves.toBe(0);
  });
});
