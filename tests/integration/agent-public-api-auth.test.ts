// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  createAgentApiKey,
  hashAgentApiSubject,
  mintAgentClientToken,
  resolveAgentApiPrincipal,
  verifyAgentApiKey,
  verifyAgentClientToken,
} from '@/lib/agents/public-api/auth';
import { takeAgentApiRateLimit } from '@/lib/agents/public-api/rate-limit';

let userId = '';
let workspaceId = '';
let agentId = '';
let endpointId = '';
let endpointPublicId = '';
let revisionId = '';
let clientId = '';
let secondClientId = '';
let token = '';

beforeAll(async () => {
  process.env.AUTH_SECRET = 'agent-public-api-integration-secret';
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const user = await db.user.create({
    data: { email: `agent-api-${suffix}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `agent-api-${suffix}`,
      name: 'Agent API',
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'owner' } },
    },
  });
  workspaceId = workspace.id;
  const agent = await db.agent.create({
    data: { workspaceId, name: 'Public source', slug: `public-source-${suffix}`, runtimeKind: 'pi' },
  });
  agentId = agent.id;
  const endpoint = await db.agentEndpoint.create({
    data: {
      publicId: `agep_${crypto.randomUUID().replaceAll('-', '')}`,
      workspaceId,
      sourceAgentId: agent.id,
      createdById: user.id,
      name: 'Public API',
      status: 'active',
      allowedOrigins: ['https://app.example.com'],
      rpmLimit: 50,
      dailyRequestLimit: 500,
      maxConcurrent: 3,
    },
  });
  endpointId = endpoint.id;
  endpointPublicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({
    data: {
      endpointId: endpoint.id,
      version: 1,
      systemPrompt: 'Safe public prompt',
      runtimeImage: 'nousresearch/hermes-agent:v2026.8.3',
      toolPolicy: {},
    },
  });
  revisionId = revision.id;
  await db.agentEndpoint.update({
    where: { id: endpoint.id },
    data: { currentRevisionId: revision.id },
  });
  const client = await db.agentApiClient.create({
    data: { endpointId: endpoint.id, createdById: user.id, name: 'Backend' },
  });
  clientId = client.id;
  const secondClient = await db.agentApiClient.create({
    data: { endpointId: endpoint.id, createdById: user.id, name: 'Other backend' },
  });
  secondClientId = secondClient.id;
  token = (await createAgentApiKey({
    clientId: client.id,
    endpointPublicId,
    workspaceId,
    sourceAgentId: agentId,
    name: 'Primary',
  })).token;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('Agent API credentials', () => {
  it('stores only a hash and resolves a key to one endpoint/client/revision', async () => {
    const stored = await db.agentApiKey.findFirstOrThrow({ where: { clientId } });
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.prefix).toMatch(/^tp_agent_/);

    const principal = await verifyAgentApiKey(
      `Bearer ${token}`,
      endpointPublicId,
      'responses:create',
    );
    expect(principal).toMatchObject({
      credentialType: 'api_key',
      endpointId,
      endpointPublicId,
      workspaceId,
      sourceAgentId: agentId,
      revisionId,
      clientId,
      subjectHash: null,
    });
    expect(await verifyAgentApiKey(`Bearer ${token}`, 'agep_wrong')).toBeNull();
  });

  it('never falls back to a dashboard cookie and rejects permanent browser credentials', async () => {
    const cookieOnly = new Request(`https://toolplane.test/api/v1/agent-endpoints/${endpointPublicId}`, {
      headers: { cookie: 'toolplane_session=dashboard-session' },
    });
    expect(await resolveAgentApiPrincipal(cookieOnly, endpointPublicId)).toBeNull();

    const browser = new Request(`https://toolplane.test/api/v1/agent-endpoints/${endpointPublicId}`, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://app.example.com',
      },
    });
    expect(await resolveAgentApiPrincipal(browser, endpointPublicId)).toBeNull();
  });

  it('binds short tokens to endpoint, client, subject, origin and delegated scopes', async () => {
    const minted = await mintAgentClientToken({
      endpointId,
      endpointPublicId,
      clientId,
      subject: 'customer-42',
      scopes: ['responses:create', 'responses:read'],
      expiresInSeconds: 300,
      origin: 'https://app.example.com',
    });
    const principal = await verifyAgentClientToken(
      `Bearer ${minted.token}`,
      endpointPublicId,
      'responses:create',
      'https://app.example.com',
    );
    expect(principal).toMatchObject({
      credentialType: 'client_token',
      clientId,
      subjectHash: hashAgentApiSubject(endpointId, clientId, 'customer-42'),
      origin: 'https://app.example.com',
    });
    expect(await verifyAgentClientToken(
      `Bearer ${minted.token}`,
      endpointPublicId,
      'responses:create',
      'https://evil.example.com',
    )).toBeNull();
    expect(await verifyAgentClientToken(
      `Bearer ${minted.token}`,
      endpointPublicId,
      'conversations:delete',
      'https://app.example.com',
    )).toBeNull();
  });

  it('namespaces identical end-user ids by API client', () => {
    expect(hashAgentApiSubject(endpointId, clientId, 'same-user')).not.toBe(
      hashAgentApiSubject(endpointId, secondClientId, 'same-user'),
    );
  });

  it('fails closed when a required scope is malformed', async () => {
    expect(await verifyAgentApiKey(
      `Bearer ${token}`,
      endpointPublicId,
      'responses create' as 'responses:create',
    )).toBeNull();
  });

  it('rejects revoked and expired keys immediately', async () => {
    const revoked = await createAgentApiKey({
      clientId,
      endpointPublicId,
      workspaceId,
      sourceAgentId: agentId,
      name: 'Revoke me',
    });
    await db.agentApiKey.update({
      where: { id: revoked.record.id },
      data: { revokedAt: new Date() },
    });
    expect(await verifyAgentApiKey(`Bearer ${revoked.token}`, endpointPublicId)).toBeNull();

    const expired = await createAgentApiKey({
      clientId,
      endpointPublicId,
      workspaceId,
      sourceAgentId: agentId,
      name: 'Expires',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await verifyAgentApiKey(
      `Bearer ${expired.token}`,
      endpointPublicId,
      undefined,
      new Date(Date.now() + 120_000),
    )).toBeNull();
  });
});

describe('Agent API database rate limits', () => {
  it('atomically admits no more than the configured minute limit', async () => {
    const unique = crypto.randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => (
      takeAgentApiRateLimit({
        endpointId: `rate-endpoint-${unique}`,
        clientId: `rate-client-${unique}`,
        endpointRpm: 3,
        clientRpm: 3,
        endpointDaily: 100,
        clientDaily: 100,
      })
    )));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(7);
    expect(rejected[0]).toMatchObject({ reason: { code: 'rate_limit_exceeded', status: 429 } });
  });

  it('rolls back shared endpoint counters when a client bucket rejects', async () => {
    const endpoint = `rate-rollback-endpoint-${crypto.randomUUID()}`;
    const firstClient = `rate-rollback-client-a-${crypto.randomUUID()}`;
    const secondClient = `rate-rollback-client-b-${crypto.randomUUID()}`;
    const limits = {
      endpointId: endpoint,
      endpointRpm: 2,
      endpointDaily: 10,
      clientRpm: 1,
      clientDaily: 10,
    };
    await takeAgentApiRateLimit({ ...limits, clientId: firstClient });
    await expect(takeAgentApiRateLimit({ ...limits, clientId: firstClient }))
      .rejects.toMatchObject({ code: 'rate_limit_exceeded' });
    await expect(takeAgentApiRateLimit({ ...limits, clientId: secondClient }))
      .resolves.toMatchObject({ remaining: 0 });
  });
});
