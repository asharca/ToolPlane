// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createAgent, deleteAgent } from '@/lib/agents/mutations';
import { deriveHermesRuntimeToken } from '@/lib/agents/hermes/token';
import { POST } from '@/app/api/v1/agent-runtimes/[runtimeId]/mcp/route';

let userId = '';
let workspaceId = '';
let agentId = '';
let runtimeId = '';
let deploymentId = '';

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `hermes-mcp-${Date.now()}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `hermes-mcp-${Date.now()}`,
      name: 'Hermes MCP',
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'owner' } },
    },
  });
  workspaceId = workspace.id;
  const agent = await createAgent(workspace.id, 'Hermes MCP', { runtime: 'hermes' });
  agentId = agent.id;
  runtimeId = (await db.agentRuntime.findUniqueOrThrow({ where: { agentId: agent.id } })).id;
  const deployment = await db.deployment.create({
    data: {
      workspaceId: workspace.id,
      name: 'Restricted MCP',
      source: 'npm',
      sourceRef: 'restricted-mcp',
      status: 'stopped',
      mcpToolExposure: 'allowlist',
      mcpAllowedTools: ['allowed'],
    },
  });
  deploymentId = deployment.id;
  await db.agentServer.create({ data: { agentId: agent.id, deploymentId } });
});

afterAll(async () => {
  await deleteAgent(workspaceId, agentId);
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

function request(token: string, method = 'initialize', params: Record<string, unknown> = {}) {
  return new Request(`http://localhost/api/v1/agent-runtimes/${runtimeId}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('Hermes runtime MCP boundary', () => {
  it('rejects tokens that were not derived for this runtime and purpose', async () => {
    const response = await POST(request(deriveHermesRuntimeToken(runtimeId, 'hermes-api')), {
      params: Promise.resolve({ runtimeId }),
    });
    expect(response.status).toBe(401);
  });

  it('serves an authenticated, agent-scoped MCP endpoint', async () => {
    const token = deriveHermesRuntimeToken(runtimeId, 'toolplane-mcp');
    const initialized = await POST(request(token), { params: Promise.resolve({ runtimeId }) });
    expect(initialized.status).toBe(200);
    await expect(initialized.json()).resolves.toMatchObject({
      result: { serverInfo: { name: 'ToolPlane: Hermes MCP' } },
    });

    const listed = await POST(request(token, 'tools/list'), { params: Promise.resolve({ runtimeId }) });
    await expect(listed.json()).resolves.toMatchObject({ result: { tools: [] } });
  });

  it('rejects cached or guessed tool names outside the deployment allowlist', async () => {
    const token = deriveHermesRuntimeToken(runtimeId, 'toolplane-mcp');
    const hidden = await POST(request(token, 'tools/call', {
      name: `${deploymentId}__hidden`,
      arguments: {},
    }), { params: Promise.resolve({ runtimeId }) });
    await expect(hidden.json()).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining('Unknown tool') },
    });

    const allowed = await POST(request(token, 'tools/call', {
      name: `${deploymentId}__allowed`,
      arguments: {},
    }), { params: Promise.resolve({ runtimeId }) });
    await expect(allowed.json()).resolves.toMatchObject({
      error: { code: -32000, message: 'tool deployment is not running' },
    });
  });
});
