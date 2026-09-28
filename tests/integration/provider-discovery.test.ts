// @vitest-environment node
import http from 'node:http';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { addProviderModelAction, createProviderAction, updateProviderModelAction } from '@/lib/agents/actions';
import { POST } from '@/app/api/v1/workspaces/[slug]/providers/[providerId]/models/route';
import { addProviderModels, setProviderModels, updateProviderModel } from '@/lib/agents/mutations';
import { defaultProviderModel } from '@/lib/agents/model-catalog';
import ProvidersPage from '@/app/app/[workspace]/providers/page';

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => auth);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key, getLocale: async () => 'en' }));

let gate = Promise.withResolvers<void>();
let sourceRequests = 0;
const source = http.createServer(async (req, res) => {
  sourceRequests++;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/slow/models') await gate.promise;
  if (req.url === '/fail/models') {
    res.statusCode = 503;
    res.end('{}');
    return;
  }
  res.end(JSON.stringify({ data: [{ id: 'gpt-5' }] }));
});
let baseUrl = '';
let slug = '';
let ownerId = '';
let memberId = '';
let workspaceId = '';
let otherWorkspaceId = '';
let providerId = '';
let foreignProviderId = '';
let personalToken = '';
let toolkitToken = '';

beforeAll(async () => {
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  baseUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ownerId = (await db.user.create({ data: { email: `provider-discovery-owner-${suffix}@test.dev`, passwordHash: 'x' } })).id;
  memberId = (await db.user.create({ data: { email: `provider-discovery-member-${suffix}@test.dev`, passwordHash: 'x' } })).id;
  slug = `provider-discovery-${suffix}`;
  workspaceId = (await db.workspace.create({ data: {
    slug, name: 'Discovery', ownerId,
    members: { create: [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }] },
  } })).id;
  otherWorkspaceId = (await db.workspace.create({ data: {
    slug: `${slug}-other`, name: 'Other discovery', ownerId,
    members: { create: { userId: ownerId, role: 'owner' } },
  } })).id;
  foreignProviderId = (await db.modelProvider.create({ data: {
    workspaceId: otherWorkspaceId, name: 'Foreign', format: 'openai', baseUrl: `${baseUrl}/ok`, apiKey: 'fixture-not-a-real-key',
  } })).id;
  providerId = (await db.modelProvider.create({ data: {
    workspaceId, name: 'Discovery source', format: 'openai', baseUrl: `${baseUrl}/ok`, apiKey: 'fixture-not-a-real-key',
  } })).id;
  personalToken = (await createApiToken(ownerId, 'Discovery test')).token;
  const toolkit = await db.toolkit.create({ data: { workspaceId, name: 'Discovery toolkit', slug: `discovery-${suffix}` } });
  toolkitToken = (await createApiToken(ownerId, 'Toolkit test', { toolkitId: toolkit.id })).token;
});

beforeEach(async () => {
  gate = Promise.withResolvers<void>();
  await db.providerModel.deleteMany({ where: { providerId } });
  await db.modelProvider.update({ where: { id: providerId }, data: { format: 'openai', baseUrl: `${baseUrl}/ok`, models: [], modelsFetchedAt: null } });
});
afterEach(() => gate.resolve());

afterAll(async () => {
  gate.resolve();
  source.closeAllConnections();
  source.close();
  await once(source, 'close');
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [ownerId, memberId].filter(Boolean) } } });
  await db.$disconnect();
});

function refresh(id = providerId, token?: string) {
  return POST(new Request(`http://localhost/api/v1/workspaces/${slug}/providers/${id}/models`, {
    method: 'POST', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  }), { params: Promise.resolve({ slug, providerId: id }) });
}

describe('separate provider save and discovery', () => {
  it('persists the provider without contacting or waiting for its model endpoint', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    const previousRequests = sourceRequests;
    const data = new FormData();
    data.set('workspace', slug);
    data.set('name', 'Slow source');
    data.set('format', 'openai');
    data.set('baseUrl', `${baseUrl}/slow`);
    data.set('apiKey', 'fixture-not-a-real-key');
    const created = await createProviderAction({}, data);
    expect(created.error).toBeUndefined();
    expect(created.warning).toBeUndefined();
    expect(created.providerId).toBeTypeOf('string');
    const stored = await db.modelProvider.findUniqueOrThrow({ where: { id: created.providerId } });
    expect(stored.models).toEqual([]);
    expect(stored.modelsFetchedAt).toBeNull();
    expect(sourceRequests).toBe(previousRequests);
  });

  it('fetches independently without overwriting manual model limits saved while discovery is pending', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    await db.modelProvider.update({ where: { id: providerId }, data: { baseUrl: `${baseUrl}/slow` } });
    const previousRequests = sourceRequests;
    const discovery = refresh();
    try {
      await vi.waitFor(() => expect(sourceRequests).toBe(previousRequests + 1));
      const before = await db.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
      expect(before.models).toEqual([]);
      const cost = { input: 7, output: 11, cacheRead: 2, cacheWrite: 3, tiers: [{ inputTokensAbove: 50_000, input: 9, output: 13, cacheRead: 3, cacheWrite: 4 }] };
      await addProviderModels(workspaceId, providerId, [{ ...defaultProviderModel('gpt-5'), contextWindow: 8192, cost }]);
      gate.resolve();
      const response = await discovery;
      expect(response.status).toBe(200);
      const after = await db.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
      expect(after.models).toEqual(['gpt-5']);
      expect(after.modelsFetchedAt).toBeInstanceOf(Date);
      const model = await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } });
      expect(model.contextWindow).toBe(8192);
      expect(model.cost).toEqual(cost);
      expect(model.source).toBe('manual');
    } finally {
      gate.resolve();
      await discovery;
    }
  });

  it('keeps the saved provider and existing model cache when discovery fails', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    expect((await refresh()).status).toBe(200);
    await db.modelProvider.update({ where: { id: providerId }, data: { baseUrl: `${baseUrl}/fail` } });
    const before = await db.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
    const response = await refresh();
    expect(response.status).toBe(502);
    const after = await db.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
    expect(after.models).toEqual(before.models);
    expect(after.modelsFetchedAt).toEqual(before.modelsFetchedAt);
    await db.modelProvider.update({ where: { id: providerId }, data: { baseUrl: `${baseUrl}/ok` } });
    expect((await refresh()).status).toBe(200);
  });

  it('accepts account tokens, but rejects Toolkit tokens and invalid Bearer credentials without cookie fallback', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    expect((await refresh(providerId, personalToken)).status).toBe(200);
    expect((await refresh(providerId, toolkitToken)).status).toBe(401);
    expect((await refresh(providerId, 'invalid-token')).status).toBe(401);
  });

  it('rejects unauthenticated callers, non-owner members, and providers outside the URL workspace', async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    expect((await refresh()).status).toBe(401);
    auth.getCurrentUser.mockResolvedValue({ id: memberId });
    expect((await refresh()).status).toBe(403);
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    expect((await refresh(foreignProviderId)).status).toBe(404);
    expect((await db.modelProvider.findUniqueOrThrow({ where: { id: foreignProviderId } })).models).toEqual([]);
  });

  it('persists independently matched cost and limits for every discovered model and fills existing gaps', async () => {
    await db.modelProvider.update({ where: { id: providerId }, data: { format: 'pi:openai' } });
    await db.providerModel.create({ data: { providerId, modelId: 'gpt-5', name: 'Private GPT', group: 'Custom', primaryType: 'embedding', capabilities: ['function_calling'], inputModalities: ['audio'], contextWindow: 8192, maxInputTokens: 4096, source: 'manual' } });
    await setProviderModels(workspaceId, providerId, ['gpt-5', 'gpt-5-mini']);
    const records = await db.providerModel.findMany({ where: { providerId }, orderBy: { modelId: 'asc' } });
    expect(records).toMatchObject([
      { modelId: 'gpt-5', name: 'Private GPT', group: 'Custom', primaryType: 'embedding', capabilities: ['function_calling'], inputModalities: ['audio'], contextWindow: 8192, maxInputTokens: 4096, maxOutputTokens: 128_000, cost: { input: 1.25, output: 10 }, source: 'manual' },
      { modelId: 'gpt-5-mini', contextWindow: 400_000, maxOutputTokens: 128_000, cost: { input: 0.25, output: 2 }, source: 'remote' },
    ]);
    const customCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    await updateProviderModel(workspaceId, providerId, { ...defaultProviderModel('gpt-5'), name: 'Renamed', contextWindow: 2048, cost: customCost });
    await setProviderModels(workspaceId, providerId, ['gpt-5', 'gpt-5-mini']);
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({ name: 'Renamed', contextWindow: 2048, cost: customCost });
  });

  it('refreshes stale discovered limits and prices from Pi without replacing manual overrides', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    const official = getBuiltinModel('openai', 'gpt-5');
    await db.providerModel.create({ data: {
      providerId, modelId: 'gpt-5', name: 'gpt-5', source: 'remote', contextWindow: 8192, maxOutputTokens: 1024, cost: { input: 99, output: 99 },
    } });
    expect((await refresh(providerId, personalToken)).status).toBe(200);
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({
      contextWindow: official.contextWindow, maxOutputTokens: official.maxTokens, cost: official.cost, source: 'remote',
    });
    await updateProviderModel(workspaceId, providerId, { ...defaultProviderModel('gpt-5'), contextWindow: 2048, maxOutputTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect((await refresh(providerId, personalToken)).status).toBe(200);
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({
      contextWindow: 2048, maxOutputTokens: 512, cost: { input: 0, output: 0 }, source: 'manual',
    });
  });

  it('preserves discovered metadata when the model has no official Pi reference', async () => {
    const stored = await db.providerModel.create({ data: {
      providerId, modelId: 'private-model', name: 'Private', source: 'remote', contextWindow: 4096, maxOutputTokens: 1024, cost: { input: 7, output: 11 },
    } });
    await setProviderModels(workspaceId, providerId, ['private-model']);
    expect(await db.providerModel.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
  });

  it('discovers native catalog prices and limits for a generic proxy even when Pi lists duplicate vendor entries', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    expect((await refresh(providerId, personalToken)).status).toBe(200);
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      contextWindow: 400_000, maxOutputTokens: 128_000,
    });
  });

  it('fills old provider-page records only after owner verification and only within that workspace', async () => {
    await db.modelProvider.update({ where: { id: providerId }, data: { format: 'pi:openai', models: ['gpt-5', 'gpt-5-mini'] } });
    const existing = await db.providerModel.create({ data: { providerId, modelId: 'gpt-5', name: 'Private GPT', group: 'Private', contextWindow: 8192, maxInputTokens: 4096, source: 'manual' } });
    const foreign = await db.providerModel.create({ data: { providerId: foreignProviderId, modelId: 'gpt-5', name: 'Foreign GPT' } });
    try {
      auth.getCurrentUser.mockResolvedValue({ id: memberId });
      await ProvidersPage({ params: Promise.resolve({ workspace: slug }) });
      expect(await db.providerModel.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ cost: null, maxOutputTokens: null });
      expect(await db.providerModel.findUnique({ where: { providerId_modelId: { providerId, modelId: 'gpt-5-mini' } } })).toBeNull();
      auth.getCurrentUser.mockResolvedValue({ id: ownerId });
      await ProvidersPage({ params: Promise.resolve({ workspace: slug }) });
      expect(await db.providerModel.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ name: 'Private GPT', group: 'Private', contextWindow: 8192, maxInputTokens: 4096, maxOutputTokens: 128_000, source: 'manual', cost: { input: 1.25, output: 10 } });
      expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5-mini' } } })).toMatchObject({ contextWindow: 400_000, cost: { input: 0.25, output: 2 } });
      expect(await db.providerModel.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ cost: null, contextWindow: null });
    } finally {
      await db.providerModel.delete({ where: { id: foreign.id } });
    }
  });

  it('validates cost at the action boundary and preserves edited tiers across saves and discovery', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    await db.modelProvider.update({ where: { id: providerId }, data: { format: 'pi:openai' } });
    const data = new FormData();
    data.set('workspace', slug);
    data.set('providerId', providerId);
    data.set('modelId', 'gpt-5');
    for (const cost of ['{"input":-1,"output":2,"cacheRead":0,"cacheWrite":0}', '{"input":1e999,"output":2,"cacheRead":0,"cacheWrite":0}', '{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"tiers":[{"inputTokensAbove":-1,"input":1,"output":2,"cacheRead":0,"cacheWrite":0}]}']) {
      data.set('cost', cost);
      expect((await addProviderModelAction({}, data)).error).toBeTypeOf('string');
      expect(await db.providerModel.findUnique({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toBeNull();
    }
    data.set('cost', 'null');
    expect((await addProviderModelAction({}, data)).error).toBeUndefined();
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({ contextWindow: 400_000, maxOutputTokens: 128_000, cost: { input: 1.25, output: 10 } });
    const editedCost = { input: 7, output: 11, cacheRead: 2, cacheWrite: 3, tiers: [
      { inputTokensAbove: 200_000, input: 12, output: 17, cacheRead: 4, cacheWrite: 5 },
      { inputTokensAbove: 50_000, input: 9, output: 13, cacheRead: 3, cacheWrite: 4 },
    ] };
    data.set('cost', JSON.stringify(editedCost));
    data.set('contextWindow', '8192');
    expect((await updateProviderModelAction({}, data)).error).toBeUndefined();
    await setProviderModels(workspaceId, providerId, ['gpt-5']);
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({ cost: editedCost, contextWindow: 8192 });
    data.delete('cost');
    expect((await updateProviderModelAction({}, data)).error).toBeUndefined();
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({ cost: editedCost });
    data.set('cost', '{"input":-1,"output":2,"cacheRead":0,"cacheWrite":0}');
    expect((await updateProviderModelAction({}, data)).error).toBeTypeOf('string');
    expect(await db.providerModel.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId: 'gpt-5' } } })).toMatchObject({ cost: editedCost });
  });

  it('matches each manually added batch model separately without copying the first model’s prices', async () => {
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    await db.modelProvider.update({ where: { id: providerId }, data: { format: 'pi:openai' } });
    const data = new FormData();
    data.set('workspace', slug);
    data.set('providerId', providerId);
    data.set('modelId', 'gpt-5,gpt-5-mini');
    data.set('cost', '{"input":7,"output":11,"cacheRead":2,"cacheWrite":3}');
    expect((await addProviderModelAction({}, data)).error).toBeUndefined();
    expect(await db.providerModel.findMany({ where: { providerId }, orderBy: { modelId: 'asc' } })).toMatchObject([
      { modelId: 'gpt-5', cost: { input: 1.25, output: 10 } },
      { modelId: 'gpt-5-mini', cost: { input: 0.25, output: 2 } },
    ]);
  });

  it('rejects member and cross-workspace manual metadata writes without creating or changing records', async () => {
    const data = new FormData();
    data.set('workspace', slug);
    data.set('providerId', providerId);
    data.set('modelId', 'gpt-5');
    data.set('cost', '{"input":7,"output":11,"cacheRead":2,"cacheWrite":3}');
    auth.getCurrentUser.mockResolvedValue({ id: memberId });
    expect((await addProviderModelAction({}, data)).error).toBe('Not authorized.');
    expect((await updateProviderModelAction({}, data)).error).toBe('Not authorized.');
    auth.getCurrentUser.mockResolvedValue({ id: ownerId });
    data.set('providerId', foreignProviderId);
    expect((await addProviderModelAction({}, data)).error).toBe('Provider not found.');
    expect((await updateProviderModelAction({}, data)).error).toBe('Provider not found.');
    expect(await db.providerModel.findMany({ where: { providerId: { in: [providerId, foreignProviderId] } } })).toEqual([]);
  });
});
