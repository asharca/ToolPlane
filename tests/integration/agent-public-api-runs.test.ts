// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { hashAgentApiSubject, type AgentApiPrincipal } from '@/lib/agents/public-api/auth';

const mocks = vi.hoisted(() => ({ ensureRuntime: vi.fn() }));

vi.mock('@/lib/agents/public-api/runtime', () => {
  class AgentEndpointRuntimeAllocationError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return {
    AgentEndpointRuntimeAllocationError,
    ensureAgentEndpointRuntime: mocks.ensureRuntime,
  };
});

import { prepareAgentResponse } from '@/lib/agents/public-api/runs';
import { activeAgentApiRunCount } from '@/lib/agents/public-api/run-control';

let userId = '';
let workspaceId = '';
let endpointId = '';
let endpointPublicId = '';
let revisionId = '';
let clientId = '';
let principal: AgentApiPrincipal;

beforeAll(async () => {
  process.env.AUTH_SECRET = 'agent-public-runs-integration-secret';
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const user = await db.user.create({
    data: { email: `agent-runs-${suffix}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `agent-runs-${suffix}`, name: 'Runs', ownerId: user.id },
  });
  workspaceId = workspace.id;
  const source = await db.agent.create({
    data: { workspaceId, name: 'Source', slug: `source-${suffix}`, runtimeKind: 'pi' },
  });
  const hidden = await db.agent.create({
    data: { workspaceId, name: 'Hidden', slug: `hidden-${suffix}`, runtimeKind: 'pi' },
  });
  const endpoint = await db.agentEndpoint.create({
    data: {
      publicId: `agep_${crypto.randomUUID().replaceAll('-', '')}`,
      workspaceId,
      sourceAgentId: source.id,
      createdById: user.id,
      name: 'Runs API',
      status: 'active',
      rpmLimit: 1_000,
      dailyRequestLimit: 10_000,
      maxConcurrent: 10,
      timeoutSeconds: 60,
    },
  });
  endpointId = endpoint.id;
  endpointPublicId = endpoint.publicId;
  const revision = await db.agentEndpointRevision.create({
    data: {
      endpointId,
      version: 1,
      systemPrompt: 'Public',
      runtimeImage: 'nousresearch/hermes-agent:v2026.8.3',
      toolPolicy: {},
    },
  });
  revisionId = revision.id;
  await db.agentEndpoint.update({ where: { id: endpointId }, data: { currentRevisionId: revision.id } });
  const client = await db.agentApiClient.create({
    data: {
      endpointId,
      name: 'Runs client',
      rpmLimit: 1_000,
      dailyRequestLimit: 10_000,
      maxConcurrent: 10,
    },
  });
  clientId = client.id;
  const subjectHash = hashAgentApiSubject(endpointId, clientId, 'subject-a');
  const allocation = await db.agentEndpointRuntime.create({
    data: {
      endpointId,
      revisionId,
      subjectHash,
      runtimeAgentId: hidden.id,
      status: 'ready',
    },
  });
  mocks.ensureRuntime.mockResolvedValue({
    allocation,
    agent: { id: hidden.id, workspaceId, slug: hidden.slug, runtime: { kind: 'hermes' } },
  });
  principal = {
    credentialType: 'api_key',
    endpointId,
    endpointPublicId,
    workspaceId,
    sourceAgentId: source.id,
    revisionId,
    clientId,
    keyId: 'key-1',
    subjectHash: null,
    origin: null,
    scopes: ['responses:create'],
    limits: { rpm: 1_000, dailyRequests: 10_000, maxConcurrent: 10, timeoutSeconds: 60, retentionDays: 30 },
    rateBuckets: {
      endpointRpm: 1_000,
      clientRpm: 1_000,
      endpointDaily: 10_000,
      clientDaily: 10_000,
    },
  };
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

async function prepare(overrides: Partial<Parameters<typeof prepareAgentResponse>[0]> = {}) {
  return prepareAgentResponse({
    principal,
    input: 'hello',
    endUser: 'subject-a',
    stream: false,
    ...overrides,
  });
}

describe('Agent API run admission', () => {
  it('creates only one durable run for concurrent idempotent requests', async () => {
    const key = `same-${crypto.randomUUID()}`;
    const results = await Promise.all([prepare({ idempotencyKey: key }), prepare({ idempotencyKey: key })]);
    expect(new Set(results.map((result) => result.responseId)).size).toBe(1);
    expect(await db.agentRun.count({ where: { clientId, idempotencyKey: key } })).toBe(1);
    const persisted = await db.agentRun.findFirstOrThrow({
      where: { clientId, idempotencyKey: key },
      select: { createdAt: true, deadlineAt: true },
    });
    const timeoutMs = persisted.deadlineAt.getTime() - persisted.createdAt.getTime();
    expect(timeoutMs).toBeGreaterThanOrEqual(59_000);
    expect(timeoutMs).toBeLessThanOrEqual(60_500);
    await db.agentRun.updateMany({
      where: { clientId, idempotencyKey: key },
      data: { status: 'completed', completedAt: new Date() },
    });
  });

  it('rejects reuse of an idempotency key with a different request', async () => {
    const key = `conflict-${crypto.randomUUID()}`;
    const first = await prepare({ idempotencyKey: key });
    await expect(prepare({ idempotencyKey: key, input: 'different' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
    });
    await db.agentRun.update({
      where: { id: first.runId },
      data: { status: 'completed', completedAt: new Date() },
    });
  });

  it('serializes turns for one conversation across concurrent workers', async () => {
    const seed = await prepare({ idempotencyKey: `seed-${crypto.randomUUID()}` });
    await db.agentRun.update({
      where: { id: seed.runId },
      data: { status: 'completed', completedAt: new Date() },
    });
    const settled = await Promise.allSettled([
      prepare({ conversationId: seed.publicConversationId, idempotencyKey: `turn-a-${crypto.randomUUID()}` }),
      prepare({ conversationId: seed.publicConversationId, idempotencyKey: `turn-b-${crypto.randomUUID()}` }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'conversation_busy', status: 409 } });
    await db.agentRun.updateMany({
      where: { publicConversation: { publicId: seed.publicConversationId }, status: 'running' },
      data: { status: 'completed', completedAt: new Date() },
    });
  });

  it('does not reveal a conversation to another subject', async () => {
    const seed = await prepare({ idempotencyKey: `subject-seed-${crypto.randomUUID()}` });
    await db.agentRun.update({
      where: { id: seed.runId },
      data: { status: 'completed', completedAt: new Date() },
    });
    await expect(prepare({
      endUser: 'subject-b',
      conversationId: seed.publicConversationId,
      idempotencyKey: `subject-b-${crypto.randomUUID()}`,
    })).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
  });

  it('reserves the maximum response against the durable daily output budget', async () => {
    await Promise.all([
      db.agentEndpoint.update({
        where: { id: endpointId },
        data: { dailyOutputCharacterLimit: 200_000 },
      }),
      db.agentApiClient.update({
        where: { id: clientId },
        data: { dailyOutputCharacterLimit: 200_000 },
      }),
    ]);
    let firstRunId: string | undefined;
    try {
      const first = await prepare({
        endUser: 'budget-a',
        idempotencyKey: `budget-a-${crypto.randomUUID()}`,
      });
      firstRunId = first.runId;
      await expect(prepare({
        endUser: 'budget-b',
        idempotencyKey: `budget-b-${crypto.randomUUID()}`,
      })).rejects.toMatchObject({ code: 'resource_limit_exceeded', status: 429 });
    } finally {
      if (firstRunId) {
        await db.agentRun.updateMany({
          where: { id: firstRunId, status: { in: ['provisioning', 'running'] } },
          data: { status: 'completed', completedAt: new Date() },
        });
      }
      await Promise.all([
        db.agentEndpoint.update({
          where: { id: endpointId },
          data: { dailyOutputCharacterLimit: 100_000_000 },
        }),
        db.agentApiClient.update({
          where: { id: clientId },
          data: { dailyOutputCharacterLimit: 20_000_000 },
        }),
      ]);
    }
  });

  it('immediately releases a provisioning run when its caller disconnects', async () => {
    const key = `disconnect-${crypto.randomUUID()}`;
    const beforeCalls = mocks.ensureRuntime.mock.calls.length;
    mocks.ensureRuntime.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = prepare({ idempotencyKey: key, signal: controller.signal });
    await vi.waitFor(() => expect(mocks.ensureRuntime.mock.calls.length).toBeGreaterThan(beforeCalls));
    controller.abort(new DOMException('Client disconnected.', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ code: 'cancelled', status: 409 });
    await expect(db.agentRun.findFirstOrThrow({
      where: { clientId, idempotencyKey: key },
      select: { status: true, errorCode: true },
    })).resolves.toEqual({ status: 'cancelled', errorCode: 'cancelled' });
    expect(activeAgentApiRunCount()).toBe(0);
  });
});
