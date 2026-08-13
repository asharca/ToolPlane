import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  revalidatePath: vi.fn(),
  ensureHermesRuntimeReady: vi.fn(),
  setAgentTools: vi.fn(),
  setHermesRuntimeEnv: vi.fn(),
  stopHermesRuntime: vi.fn(),
  syncHermesRuntime: vi.fn(),
  updateAgent: vi.fn(),
  upgradeHermesRuntime: vi.fn(),
  agentFindFirst: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/agents/queries', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: { agent: { findFirst: mocks.agentFindFirst } },
}));
vi.mock('@/lib/agents/mutations', () => ({
  cloneAgent: vi.fn(),
  cloneHermesVolumeData: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: mocks.updateAgent,
  setAgentTools: mocks.setAgentTools,
  deleteAgent: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setProviderModels: vi.fn(),
  createConversation: vi.fn(),
  setHermesRuntimeEnv: mocks.setHermesRuntimeEnv,
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
  ensureHermesRuntimeReady: mocks.ensureHermesRuntimeReady,
  stopHermesRuntime: mocks.stopHermesRuntime,
  syncHermesRuntime: mocks.syncHermesRuntime,
  upgradeHermesRuntime: mocks.upgradeHermesRuntime,
}));

import {
  stopAgentRuntimeAction,
  syncAgentRuntimeAction,
  updateAgentAction,
  updateHermesRuntimeEnvAction,
  upgradeHermesRuntimeAction,
} from '@/lib/agents/actions';

function upgradeForm(image = 'nousresearch/hermes-agent:v2026.8.3') {
  const form = new FormData();
  form.set('workspace', 'acme');
  form.set('agentId', 'agent-1');
  form.set('hermesImage', image);
  return form;
}

function runtimeForm() {
  const form = new FormData();
  form.set('workspace', 'acme');
  form.set('agentId', 'agent-1');
  return form;
}

function mockAuthorizedAgent() {
  mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
  mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
  mocks.agentFindFirst.mockResolvedValue({
    publicRuntimeAllocation: null,
    runtime: { sandbox: { config: { managedBy: 'agent-runtime' } } },
  });
}

describe('upgradeHermesRuntimeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
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

describe('Hermes runtime control actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.ensureHermesRuntimeReady.mockResolvedValue({ port: 4312 });
    mocks.setHermesRuntimeEnv.mockResolvedValue(true);
    mocks.syncHermesRuntime.mockResolvedValue({ status: 'stopped' });
  });

  it('forces an explicit sync and waits for a provisioning runtime to become healthy', async () => {
    mocks.syncHermesRuntime.mockResolvedValueOnce({ status: 'provisioning' });

    const result = await syncAgentRuntimeAction({}, runtimeForm());

    expect(result.savedAt).toEqual(expect.any(Number));
    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      { force: true },
    );
    expect(mocks.ensureHermesRuntimeReady).toHaveBeenCalledWith('workspace-1', 'agent-1');
  });

  it('reports a failed health check instead of claiming a provisioning sync succeeded', async () => {
    mocks.syncHermesRuntime.mockResolvedValueOnce({ status: 'provisioning' });
    mocks.ensureHermesRuntimeReady.mockResolvedValueOnce({
      error: 'Hermes gateway did not become healthy within 45 seconds.',
    });

    await expect(syncAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      error: 'Hermes gateway did not become healthy within 45 seconds.',
    });
  });

  it('keeps agent autosave hash-based and forces an explicit environment sync', async () => {
    const agentForm = runtimeForm();
    agentForm.set('name', 'Hermes');
    await expect(updateAgentAction({}, agentForm)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.syncHermesRuntime).toHaveBeenLastCalledWith('workspace-1', 'agent-1');

    mocks.syncHermesRuntime.mockClear();
    const envForm = runtimeForm();
    envForm.set('hermesEnv', 'CHANNEL_TOKEN=value');
    await expect(updateHermesRuntimeEnvAction({}, envForm)).resolves.toEqual({
      savedAt: expect.any(Number),
    });
    expect(mocks.syncHermesRuntime).toHaveBeenLastCalledWith(
      'workspace-1',
      'agent-1',
      { force: true },
    );
  });

  it('waits for a forced environment restart to become healthy', async () => {
    mocks.syncHermesRuntime.mockResolvedValueOnce({ status: 'provisioning' });
    const envForm = runtimeForm();
    envForm.set('hermesEnv', 'CUSTOM_SETTING=value');

    await expect(updateHermesRuntimeEnvAction({}, envForm)).resolves.toEqual({
      savedAt: expect.any(Number),
    });

    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      { force: true },
    );
    expect(mocks.ensureHermesRuntimeReady).toHaveBeenCalledWith('workspace-1', 'agent-1');
  });

  it('returns the strict stop failure to the caller', async () => {
    mocks.stopHermesRuntime.mockRejectedValueOnce(
      new Error('Could not stop the Hermes runtime: Docker daemon unavailable'),
    );

    await expect(stopAgentRuntimeAction({}, runtimeForm())).resolves.toEqual({
      error: 'Could not stop the Hermes runtime: Docker daemon unavailable',
    });
  });
});
