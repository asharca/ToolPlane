import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  acquire: vi.fn(() => ({ release: vi.fn() })),
  dashboardReady: vi.fn(async () => ({ port: 4312 })),
  runtimeReady: vi.fn(async () => ({ port: 4312 })),
  mutate: vi.fn(async (_workspaceId, _agentId, _lease, operation) => operation({ port: 4312 })),
  syncProfile: vi.fn(async () => true),
  syncRuntime: vi.fn(async () => ({ status: 'provisioning' })),
}));

vi.mock('@/lib/agents/hermes/runtime', () => ({
  acquireHermesRuntimeWriteLease: runtimeMocks.acquire,
  ensureHermesDashboardReady: runtimeMocks.dashboardReady,
  ensureHermesRuntimeReady: runtimeMocks.runtimeReady,
  runHermesDashboardMutation: runtimeMocks.mutate,
  syncHermesProfileProjection: runtimeMocks.syncProfile,
  syncHermesRuntime: runtimeMocks.syncRuntime,
}));

import {
  ensureHermesProfileProjection,
  hasHermesProfileChatCapabilities,
  listHermesProfileModels,
  listHermesProfiles,
  setHermesProfileDefaultModel,
  supportsHermesProfileChat,
} from '@/lib/agents/hermes/profiles';

const agent = {
  id: 'agent-1',
  workspaceId: 'workspace-1',
  runtime: { id: 'runtime-1', kind: 'hermes' },
};

describe('Hermes profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns only safe structured profile and model fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ profiles: [{
        name: 'research',
        path: '/opt/data/profiles/research',
        is_default: false,
        provider: 'openrouter',
        model: 'model-a',
        description: 'Research',
      }, { name: '../escape' }] }))
      .mockResolvedValueOnce(Response.json({
        provider: 'openrouter',
        model: 'model-a',
        providers: [
          { slug: 'openrouter', name: 'OpenRouter', models: ['model-a', 'model-b'] },
          { slug: 'disabled', name: 'Disabled', authenticated: false, models: ['hidden'] },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listHermesProfiles(agent)).resolves.toEqual([{
      name: 'research',
      isDefault: false,
      provider: 'openrouter',
      model: 'model-a',
      description: 'Research',
    }]);
    await expect(listHermesProfileModels(agent, 'research')).resolves.toEqual({
      profile: 'research',
      provider: 'openrouter',
      model: 'model-a',
      providers: [{ id: 'openrouter', name: 'OpenRouter', models: ['model-a', 'model-b'] }],
    });
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('/opt/data');
  });

  it('writes the profile default and projects a named profile', async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await setHermesProfileDefaultModel(agent, 'research', 'openrouter', 'model-a');
    await ensureHermesProfileProjection(agent, 'research');

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://127.0.0.1:4312/hermes-dashboard/api/profiles/research/model',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      provider: 'openrouter',
      model: 'model-a',
    });
    expect(runtimeMocks.syncProfile).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'research',
      expect.any(Object),
    );
  });

  it('requires every profile chat capability', () => {
    expect(hasHermesProfileChatCapabilities({ features: {
      session_resources: true,
      session_chat_streaming: true,
      session_model_lock: true,
    } })).toBe(true);
    expect(hasHermesProfileChatCapabilities({ features: {
      session_resources: true,
      session_chat_streaming: true,
    } })).toBe(false);
  });

  it('probes capabilities without requiring a configured model provider', async () => {
    runtimeMocks.dashboardReady.mockResolvedValueOnce({ port: 4312 });
    runtimeMocks.runtimeReady.mockResolvedValueOnce({ error: 'No model provider configured.' } as never);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {
      session_resources: true,
      session_chat_streaming: true,
      session_model_lock: true,
    } })));

    await expect(supportsHermesProfileChat(agent)).resolves.toBe(true);
    expect(runtimeMocks.dashboardReady).toHaveBeenCalledWith('workspace-1', 'agent-1');
    expect(runtimeMocks.runtimeReady).not.toHaveBeenCalled();
  });

  it('reprojects stale runtime credentials and retries the capability probe once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ features: {
        session_resources: true,
        session_chat_streaming: true,
        session_model_lock: true,
      } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(supportsHermesProfileChat(agent)).resolves.toBe(true);
    expect(runtimeMocks.syncRuntime).toHaveBeenCalledWith('workspace-1', 'agent-1', { force: true });
    expect(runtimeMocks.dashboardReady).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not classify a repeated authentication failure as an unsupported Hermes version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      Response.json({ error: 'Unauthorized' }, { status: 401 })
    )));

    await expect(supportsHermesProfileChat(agent)).rejects.toThrow(
      'Hermes gateway authentication is out of sync.',
    );
  });
});
