// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createAgentApiKey, mintAgentClientToken } from '@/lib/agents/public-api/auth';
import { handleAgentServiceMcp } from '@/lib/agents/public-api/service-mcp';

let userId = '';
let workspaceId = '';
let agentId = '';
let endpointId = '';
let endpointPublicId = '';
let clientId = '';
let token = '';
const previousSecret = process.env.AUTH_SECRET;

beforeAll(async () => {
  process.env.AUTH_SECRET = 'agent-service-mcp-isolated-test-secret';
  const suffix = randomUUID();
  userId = (await db.user.create({ data: { email: `service-mcp-${suffix}@test.dev`, passwordHash: 'x' } })).id;
  workspaceId = (await db.workspace.create({ data: { slug: `service-mcp-${suffix}`, name: 'Service MCP test', ownerId: userId } })).id;
  agentId = (await db.agent.create({ data: { workspaceId, name: 'Source', slug: 'source', runtimeKind: 'pi' } })).id;
  const endpoint = await db.agentEndpoint.create({ data: {
    publicId: `agep_${randomUUID().replaceAll('-', '')}`, workspaceId, sourceAgentId: agentId,
    createdById: userId, name: 'Service', status: 'active', rpmLimit: 1000, dailyRequestLimit: 5000,
  } });
  endpointId = endpoint.id;
  endpointPublicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({ data: {
    endpointId, version: 1, systemPrompt: 'PRIVATE_PROMPT_MUST_NOT_LEAK',
    runtimeImage: 'fixture/no-runtime-is-started:test', toolPolicy: {},
  } });
  await db.agentEndpoint.update({ where: { id: endpointId }, data: { currentRevisionId: revision.id } });
  clientId = (await db.agentApiClient.create({ data: {
    endpointId, createdById: userId, name: 'Reader', scopes: ['responses:read'],
    rpmLimit: 1000, dailyRequestLimit: 5000,
  } })).id;
  token = (await createAgentApiKey({ clientId, endpointPublicId, workspaceId, sourceAgentId: agentId, name: 'Test' })).token;
});

afterAll(async () => {
  try {
    if (workspaceId) {
      await db.auditEvent.deleteMany({ where: { workspaceId } });
      await db.workspace.delete({ where: { id: workspaceId } });
    }
    if (userId) await db.user.delete({ where: { id: userId } });
  } finally {
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
    await db.$disconnect();
  }
});

function request(authorization?: string, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
  return new Request(`https://toolplane.test/api/v1/agent-endpoints/${endpointPublicId}/mcp`, {
    method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      cookie: 'toolplane_session=not-an-agent-credential',
      ...(authorization ? { authorization } : {}),
    }, body: JSON.stringify(body),
  });
}

describe('Agent service MCP real credential boundary', () => {
  it('returns a scope-filtered catalog without private configuration', async () => {
    const response = await handleAgentServiceMcp(request(`Bearer ${token}`), endpointPublicId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_agent_response']);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PROMPT_MUST_NOT_LEAK');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(agentId);
  });

  it('never substitutes Cookie or personal-shaped credentials for an Endpoint credential', async () => {
    expect((await handleAgentServiceMcp(request(), endpointPublicId)).status).toBe(401);
    expect((await handleAgentServiceMcp(request('Bearer tp_personal_wrong-kind'), endpointPublicId)).status).toBe(401);
  });

  it('binds a real hashed key to exactly one Endpoint', async () => {
    expect((await handleAgentServiceMcp(request(`Bearer ${token}`), 'agep_different_endpoint')).status).toBe(401);
  });

  it('rejects a guessed write tool under a genuine read-only key without creating a run', async () => {
    const response = await handleAgentServiceMcp(request(`Bearer ${token}`, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'invoke_agent', arguments: { input: 'Do work', end_user: 'u', idempotency_key: 'write-attempt' },
      },
    }), endpointPublicId);
    expect((await response.json()).result.isError).toBe(true);
    expect(await db.agentRun.count({ where: { endpointId } })).toBe(0);
  });

  it('accepts subject-bound server tokens without granting additional tools', async () => {
    const minted = await mintAgentClientToken({ endpointId, endpointPublicId, clientId,
      subject: 'user-1', scopes: ['responses:read'], expiresInSeconds: 300 });
    const response = await handleAgentServiceMcp(request(`Bearer ${minted.token}`), endpointPublicId);
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_agent_response']);
  });

  it('rechecks key revocation on every request', async () => {
    await db.agentApiKey.updateMany({ where: { clientId }, data: { revokedAt: new Date() } });
    try {
      expect((await handleAgentServiceMcp(request(`Bearer ${token}`), endpointPublicId)).status).toBe(401);
    } finally {
      await db.agentApiKey.updateMany({ where: { clientId }, data: { revokedAt: null } });
    }
  });
});
