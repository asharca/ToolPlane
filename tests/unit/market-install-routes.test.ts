// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccountRequestUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  installMarketRelease: vi.fn(),
  listWorkspaceMarketInstalls: vi.fn(),
  updateMarketInstall: vi.fn(),
  ignoreMarketUpdate: vi.fn(),
  removeMarketInstall: vi.fn(),
  marketReleaseFindUnique: vi.fn(),
  agentReleaseFindUnique: vi.fn(),
  agentInstallFindMany: vi.fn(),
  agentInstallFindFirst: vi.fn(),
  chatAssistantFindMany: vi.fn(),
  chatAssistantFindFirst: vi.fn(),
  materializeAgentRelease: vi.fn(),
  syncHermesRuntime: vi.fn(),
  installAssistantMarketRelease: vi.fn(),
  deleteManagedAgent: vi.fn(),
  deleteChatAssistant: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({
  resolveAccountRequestUser: mocks.resolveAccountRequestUser,
}));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    marketRelease: { findUnique: mocks.marketReleaseFindUnique },
    agentRelease: { findUnique: mocks.agentReleaseFindUnique },
    agentInstall: {
      findMany: mocks.agentInstallFindMany,
      findFirst: mocks.agentInstallFindFirst,
    },
    chatAssistant: {
      findMany: mocks.chatAssistantFindMany,
      findFirst: mocks.chatAssistantFindFirst,
    },
  },
}));
vi.mock('@/lib/agents/market', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/agents/market')>(),
  materializeAgentRelease: mocks.materializeAgentRelease,
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({ syncHermesRuntime: mocks.syncHermesRuntime }));
vi.mock('@/lib/agents/deletion', () => ({ deleteManagedAgent: mocks.deleteManagedAgent }));
vi.mock('@/lib/chat/service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/chat/service')>(),
  installAssistantMarketRelease: mocks.installAssistantMarketRelease,
  deleteChatAssistant: mocks.deleteChatAssistant,
}));
vi.mock('@/lib/market/skills', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/market/skills')>(),
  listWorkspaceMarketInstalls: mocks.listWorkspaceMarketInstalls,
  ignoreMarketUpdate: mocks.ignoreMarketUpdate,
  removeMarketInstall: mocks.removeMarketInstall,
}));
vi.mock('@/lib/market/resources', () => ({
  installMarketRelease: mocks.installMarketRelease,
  updateMarketInstall: mocks.updateMarketInstall,
}));

import { GET, POST } from '@/app/api/v1/workspaces/[slug]/market/installs/route';
import { DELETE, PATCH } from '@/app/api/v1/workspaces/[slug]/market/installs/[installId]/route';

const collectionContext = { params: Promise.resolve({ slug: 'smoke' }) };
const itemContext = { params: Promise.resolve({ slug: 'smoke', installId: 'install-1' }) };

describe('market install API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccountRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'smoke' });
    mocks.marketReleaseFindUnique.mockResolvedValue({ listing: { kind: 'skill' } });
    mocks.agentReleaseFindUnique.mockResolvedValue(null);
    mocks.agentInstallFindMany.mockResolvedValue([]);
    mocks.agentInstallFindFirst.mockResolvedValue(null);
    mocks.chatAssistantFindMany.mockResolvedValue([]);
    mocks.chatAssistantFindFirst.mockResolvedValue(null);
    mocks.installMarketRelease.mockResolvedValue({
      install: { id: 'install-1', status: 'ready' },
      kind: 'skill',
      resource: { id: 'skill-1' },
      reused: false,
    });
    mocks.updateMarketInstall.mockResolvedValue({ id: 'install-1', status: 'ready' });
    mocks.ignoreMarketUpdate.mockResolvedValue({ id: 'install-1', status: 'ready' });
    mocks.removeMarketInstall.mockResolvedValue({ id: 'install-1' });
    mocks.materializeAgentRelease.mockResolvedValue({
      install: { id: 'agent-install-1', status: 'ready' },
      agent: { id: 'agent-1' },
      reused: false,
    });
    mocks.syncHermesRuntime.mockResolvedValue({ status: 'ready' });
    mocks.installAssistantMarketRelease.mockResolvedValue({ id: 'assistant-1' });
    mocks.deleteManagedAgent.mockResolvedValue(true);
    mocks.deleteChatAssistant.mockResolvedValue(undefined);
  });

  it('installs only into the workspace resolved for the authenticated user', async () => {
    const response = await POST(new Request('http://toolplane.test/api/v1/workspaces/smoke/market/installs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ releaseId: 'release-1', idempotencyKey: 'request-1' }),
    }), collectionContext);

    expect(response.status).toBe(201);
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledWith('smoke', 'user-1');
    expect(mocks.installMarketRelease).toHaveBeenCalledWith({
      releaseId: 'release-1',
      idempotencyKey: 'request-1',
      targetWorkspaceId: 'workspace-1',
      installedById: 'user-1',
    });
  });

  it('keeps update and delete operations inside the same workspace boundary', async () => {
    const update = await PATCH(new Request('http://toolplane.test/update', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'update',
        targetReleaseId: 'release-2',
        currentReleaseId: 'release-1',
        force: true,
      }),
    }), itemContext);
    const remove = await DELETE(new Request('http://toolplane.test/delete', { method: 'DELETE' }), itemContext);

    expect(update.status).toBe(200);
    expect(remove.status).toBe(204);
    expect(mocks.updateMarketInstall).toHaveBeenCalledWith({
      installId: 'install-1',
      targetWorkspaceId: 'workspace-1',
      actorId: 'user-1',
      targetReleaseId: 'release-2',
      currentReleaseId: 'release-1',
      force: true,
    });
    expect(mocks.removeMarketInstall).toHaveBeenCalledWith({
      installId: 'install-1',
      targetWorkspaceId: 'workspace-1',
      actorId: 'user-1',
    });
  });

  it('does not touch market services without an authorized workspace', async () => {
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    const response = await POST(new Request('http://toolplane.test/api/v1/workspaces/foreign/market/installs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ releaseId: 'release-1' }),
    }), { params: Promise.resolve({ slug: 'foreign' }) });

    expect(response.status).toBe(401);
    expect(mocks.installMarketRelease).not.toHaveBeenCalled();
  });

  it('installs assistant and agent releases through their real materializers', async () => {
    mocks.marketReleaseFindUnique.mockResolvedValueOnce({ listing: { kind: 'assistant' } });
    const assistant = await POST(new Request('http://toolplane.test/install', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ releaseId: 'assistant-release' }),
    }), collectionContext);
    mocks.marketReleaseFindUnique.mockResolvedValueOnce(null);
    mocks.agentReleaseFindUnique.mockResolvedValueOnce({ id: 'agent-release' });
    const agent = await POST(new Request('http://toolplane.test/install', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ releaseId: 'agent-release' }),
    }), collectionContext);

    expect(assistant.status).toBe(201);
    expect(await assistant.json()).toMatchObject({
      installId: 'assistant:assistant-1',
      kind: 'assistant',
      assistantId: 'assistant-1',
    });
    expect(mocks.installAssistantMarketRelease).toHaveBeenCalledWith('user-1', expect.objectContaining({
      workspaceId: 'workspace-1',
      releaseId: 'assistant-release',
    }));
    expect(agent.status).toBe(201);
    expect(await agent.json()).toMatchObject({
      installId: 'agent:agent-install-1',
      kind: 'agent',
      agentId: 'agent-1',
    });
    expect(mocks.materializeAgentRelease).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: 'agent-release',
      targetWorkspaceId: 'workspace-1',
      installedById: 'user-1',
    }));
    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith('workspace-1', 'agent-1');
    expect(mocks.installMarketRelease).not.toHaveBeenCalled();
  });

  it('accepts the shared assistant tool-loop ceiling and rejects values above it', async () => {
    mocks.marketReleaseFindUnique.mockResolvedValue({ listing: { kind: 'assistant' } });
    const accepted = await POST(new Request('http://toolplane.test/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ releaseId: 'assistant-release', maxSteps: 1_000 }),
    }), collectionContext);
    const rejected = await POST(new Request('http://toolplane.test/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ releaseId: 'assistant-release', maxSteps: 1_001 }),
    }), collectionContext);

    expect(accepted.status).toBe(201);
    expect(mocks.installAssistantMarketRelease).toHaveBeenCalledWith('user-1', expect.objectContaining({
      maxSteps: 1_000,
    }));
    expect(rejected.status).toBe(400);
    expect(mocks.installAssistantMarketRelease).toHaveBeenCalledTimes(1);
  });

  it('lists unified, agent, and assistant installs with deletable typed ids', async () => {
    mocks.listWorkspaceMarketInstalls.mockResolvedValue([{
      id: 'install-1',
      status: 'ready',
      listing: { kind: 'skill' },
      currentRelease: { id: 'release-1', version: 1 },
      deploymentId: null,
      installedSkillId: 'skill-1',
      toolkitId: null,
      agentId: null,
      updateAvailable: false,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }]);
    mocks.agentInstallFindMany.mockResolvedValue([{
      id: 'agent-install-1',
      status: 'ready',
      agent: { id: 'agent-1', name: 'Agent', runtimeKind: 'pi' },
      release: {
        id: 'agent-release-1',
        version: 1,
        listing: { status: 'published', latestRelease: { id: 'agent-release-1', version: 1 } },
      },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }]);
    mocks.chatAssistantFindMany.mockResolvedValue([{
      id: 'assistant-1',
      name: 'Assistant',
      marketTemplateRelease: {
        id: 'assistant-release-1',
        version: 1,
        listing: { status: 'published', latestRelease: { id: 'assistant-release-1', version: 1 } },
      },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }]);

    const response = await GET(new Request('http://toolplane.test/installs'), collectionContext);

    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'install-1', kind: 'skill', resourceId: 'skill-1' }),
      expect.objectContaining({ id: 'agent:agent-install-1', kind: 'agent', resourceId: 'agent-1' }),
      expect.objectContaining({ id: 'assistant:assistant-1', kind: 'assistant', resourceId: 'assistant-1' }),
    ]));
  });

  it('deletes agent and assistant copies through their lifecycle-aware services', async () => {
    mocks.agentInstallFindFirst.mockResolvedValue({ agentId: 'agent-1' });
    mocks.chatAssistantFindFirst.mockResolvedValue({ id: 'assistant-1' });

    const agent = await DELETE(new Request('http://toolplane.test/delete', { method: 'DELETE' }), {
      params: Promise.resolve({ slug: 'smoke', installId: 'agent:agent-install-1' }),
    });
    const assistant = await DELETE(new Request('http://toolplane.test/delete', { method: 'DELETE' }), {
      params: Promise.resolve({ slug: 'smoke', installId: 'assistant:assistant-1' }),
    });

    expect(agent.status).toBe(204);
    expect(assistant.status).toBe(204);
    expect(mocks.agentInstallFindFirst).toHaveBeenCalledWith({
      where: { id: 'agent-install-1', targetWorkspaceId: 'workspace-1' },
      select: { agentId: true },
    });
    expect(mocks.chatAssistantFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'assistant-1',
        workspaceId: 'workspace-1',
        marketTemplateReleaseId: { not: null },
      },
      select: { id: true },
    });
    expect(mocks.deleteManagedAgent).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      actorId: 'user-1',
    });
    expect(mocks.deleteChatAssistant).toHaveBeenCalledWith('user-1', 'assistant-1');
    expect(mocks.removeMarketInstall).not.toHaveBeenCalled();
  });

  it('rejects scoped credentials before either market route resolves a workspace', async () => {
    mocks.resolveAccountRequestUser.mockResolvedValue(null);
    const install = await POST(new Request('http://toolplane.test/install', {
      method: 'POST',
    }), collectionContext);
    const update = await PATCH(new Request('http://toolplane.test/update', {
      method: 'PATCH',
    }), itemContext);

    expect(install.status).toBe(401);
    expect(update.status).toBe(401);
    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();
    expect(mocks.installMarketRelease).not.toHaveBeenCalled();
    expect(mocks.updateMarketInstall).not.toHaveBeenCalled();
  });
});
