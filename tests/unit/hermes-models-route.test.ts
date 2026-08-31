// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestUser: vi.fn(),
  getAgentForRequest: vi.fn(),
  listProviders: vi.fn(),
  listHermesProfiles: vi.fn(),
}));

vi.mock('@/lib/auth/request-user', () => ({ resolveRequestUser: mocks.resolveRequestUser }));
vi.mock('@/lib/agents/queries', () => ({
  getAgentForRequest: mocks.getAgentForRequest,
  listProviders: mocks.listProviders,
}));
vi.mock('@/lib/agents/hermes/profiles', () => ({
  HermesProfileError: class HermesProfileError extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  },
  listHermesProfiles: mocks.listHermesProfiles,
  normalizeHermesProfile: (value: unknown) => {
    const profile = String(value ?? '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ? profile : null;
  },
}));

import { GET } from '@/app/api/v1/agents/[agentId]/hermes/models/route';

describe('Hermes profile models route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestUser.mockResolvedValue({ id: 'user-1' });
    mocks.getAgentForRequest.mockResolvedValue({
      id: 'agent-1',
      workspaceId: 'workspace-1',
      runtime: { id: 'runtime-1', kind: 'hermes' },
    });
    mocks.listProviders.mockResolvedValue([{
      id: 'provider-1',
      name: 'ToolPlane Provider',
      models: ['model-a'],
      modelRecords: [{
        modelId: 'model-a',
        primaryType: 'text',
        capabilities: ['reasoning'],
        inputModalities: ['text'],
      }],
    }]);
  });

  it('returns only ToolPlane workspace models and maps the current Hermes alias', async () => {
    mocks.listHermesProfiles.mockResolvedValue([{
      name: 'default',
      isDefault: true,
      provider: 'custom:toolplane-provider-1',
      model: 'model-a',
      description: '',
    }]);

    const response = await GET(
      new Request('http://localhost/api/v1/agents/agent-1/hermes/models?profile=default'),
      { params: Promise.resolve({ agentId: 'agent-1' }) },
    );

    await expect(response.json()).resolves.toEqual({
      profile: 'default',
      provider: 'toolplane-provider-1',
      model: 'model-a',
      providers: [{
        id: 'toolplane-provider-1',
        name: 'ToolPlane Provider',
        models: ['model-a'],
        modelRecords: [{
          modelId: 'model-a',
          primaryType: 'text',
          capabilities: ['reasoning'],
          inputModalities: ['text'],
        }],
      }],
    });
  });
});
