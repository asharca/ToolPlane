import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  revalidatePath: vi.fn(),
  upgradeHermesRuntime: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/agents/queries', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/agents/mutations', () => ({
  cloneAgent: vi.fn(),
  cloneHermesVolumeData: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  setAgentTools: vi.fn(),
  deleteAgent: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setProviderModels: vi.fn(),
  createConversation: vi.fn(),
  setHermesRuntimeEnv: vi.fn(),
}));
vi.mock('@/lib/agents/channel-connections', () => ({
  createAgentChannelConnection: vi.fn(),
  deleteAgentChannelConnection: vi.fn(),
  updateAgentChannelConnectionCredentials: vi.fn(),
}));
vi.mock('@/lib/agents/channel-pairing', () => ({
  applyAgentChannelPairing: vi.fn(),
  checkAgentChannelPairing: vi.fn(),
  requestAgentChannelPairing: vi.fn(),
}));
vi.mock('@/lib/agents/market', () => ({
  AgentMarketError: class AgentMarketError extends Error { code = 'install_failed'; },
  materializeAgentRelease: vi.fn(),
  publishAgentRelease: vi.fn(),
  unpublishAgentListing: vi.fn(),
  withdrawPendingAgentRelease: vi.fn(),
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  cleanupHermesRuntime: vi.fn(),
  copyHermesRuntimeVolume: vi.fn(),
  stopHermesRuntime: vi.fn(),
  syncHermesRuntime: vi.fn(),
  upgradeHermesRuntime: mocks.upgradeHermesRuntime,
}));

import { upgradeHermesRuntimeAction } from '@/lib/agents/actions';

function upgradeForm(image = 'nousresearch/hermes-agent:v2026.8.3') {
  const form = new FormData();
  form.set('workspace', 'acme');
  form.set('agentId', 'agent-1');
  form.set('hermesImage', image);
  return form;
}

describe('upgradeHermesRuntimeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.upgradeHermesRuntime.mockResolvedValue({ status: 'provisioning' });
  });

  it('authorizes through the workspace and forwards a trimmed image choice', async () => {
    const result = await upgradeHermesRuntimeAction(
      {},
      upgradeForm('  nousresearch/hermes-agent:v2026.8.3  '),
    );

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledWith('acme', 'user-1');
    expect(mocks.upgradeHermesRuntime).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'nousresearch/hermes-agent:v2026.8.3',
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/agents');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/agents/agent-1');
  });

  it('does not contact Docker through the runtime without workspace access', async () => {
    mocks.getWorkspaceForUser.mockResolvedValue(null);

    await expect(upgradeHermesRuntimeAction({}, upgradeForm())).resolves.toEqual({
      error: 'Not authorized.',
    });
    expect(mocks.upgradeHermesRuntime).not.toHaveBeenCalled();
  });

  it('returns the runtime pull or rebuild failure to the settings form', async () => {
    mocks.upgradeHermesRuntime.mockResolvedValue({
      status: 'error',
      error: 'Could not pull Hermes image: manifest unknown',
    });

    await expect(upgradeHermesRuntimeAction({}, upgradeForm())).resolves.toEqual({
      error: 'Could not pull Hermes image: manifest unknown',
    });
  });
});
