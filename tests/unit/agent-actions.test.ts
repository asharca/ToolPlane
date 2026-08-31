import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  revalidatePath: vi.fn(),
  ensureHermesRuntimeReady: vi.fn(),
  createConfiguredAgent: vi.fn(),
  setAgentTools: vi.fn(),
  setHermesRuntimeEnv: vi.fn(),
  stopHermesRuntime: vi.fn(),
  syncHermesRuntime: vi.fn(),
  runHermesRuntimeMaintenance: vi.fn(),
  requestHermesRuntimeSync: vi.fn(),
  updateAgent: vi.fn(),
  updateProvider: vi.fn(),
  upgradeHermesRuntime: vi.fn(),
  agentFindFirst: vi.fn(),
  createConversation: vi.fn(),
  renameConsoleConversation: vi.fn(),
  generateConsoleConversationTitle: vi.fn(),
  deleteConsoleConversation: vi.fn(),
  updateAgentModelSelection: vi.fn(),
  bindHermesAgentModelProvider: vi.fn(),
  setHermesConversationSelection: vi.fn(),
  agentFindMany: vi.fn(),
  listHermesProfiles: vi.fn(),
  listHermesProfileModels: vi.fn(),
  supportsHermesProfileChat: vi.fn(),
  ensureHermesProfileProjection: vi.fn(),
  getProvider: vi.fn(),
  workspaceUpdate: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/agents/queries', () => ({ getProvider: mocks.getProvider }));
vi.mock('@/lib/agents/conversation-naming', () => ({
  generateConsoleConversationTitle: mocks.generateConsoleConversationTitle,
}));
vi.mock('@/lib/db', () => ({
  db: {
    agent: { findFirst: mocks.agentFindFirst, findMany: mocks.agentFindMany },
    workspace: { update: mocks.workspaceUpdate },
  },
}));
vi.mock('@/lib/agents/mutations', () => ({
  cloneAgent: vi.fn(),
  cloneHermesVolumeData: vi.fn(),
  createConfiguredAgent: mocks.createConfiguredAgent,
  AgentConfigurationError: class AgentConfigurationError extends Error {},
  updateAgent: mocks.updateAgent,
  setAgentTools: mocks.setAgentTools,
  deleteAgent: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: mocks.updateProvider,
  deleteProvider: vi.fn(),
  setProviderModels: vi.fn(),
  createConversation: mocks.createConversation,
  renameConsoleConversation: mocks.renameConsoleConversation,
  deleteConsoleConversation: mocks.deleteConsoleConversation,
  updateAgentModelSelection: mocks.updateAgentModelSelection,
  bindHermesAgentModelProvider: mocks.bindHermesAgentModelProvider,
  setHermesConversationSelection: mocks.setHermesConversationSelection,
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
  runHermesRuntimeMaintenance: mocks.runHermesRuntimeMaintenance,
  stopHermesRuntime: mocks.stopHermesRuntime,
  syncHermesRuntime: mocks.syncHermesRuntime,
  upgradeHermesRuntime: mocks.upgradeHermesRuntime,
}));
vi.mock('@/lib/agents/hermes/profiles', () => ({
  ensureHermesProfileProjection: mocks.ensureHermesProfileProjection,
  hasHermesProfileModel: (
    options: { providers: Array<{ id: string; models: string[] }> },
    provider: string,
    model: string,
  ) => options.providers.some((item) => item.id === provider && item.models.includes(model)),
  HermesProfileError: class HermesProfileError extends Error {},
  listHermesProfileModels: mocks.listHermesProfileModels,
  listHermesProfiles: mocks.listHermesProfiles,
  normalizeHermesProfile: (value: unknown) => {
    const profile = String(value ?? '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ? profile : null;
  },
  setHermesProfileDefaultModel: vi.fn(),
  supportsHermesProfileChat: mocks.supportsHermesProfileChat,
}));

import {
  stopAgentRuntimeAction,
  syncAgentRuntimeAction,
  createAgentAction,
  updateAgentAction,
  updateAgentModelAction,
  updateHermesConversationSelectionAction,
  updateProviderAction,
  updateWorkspaceModelPreferenceAction,
  updateHermesRuntimeEnvAction,
  upgradeHermesRuntimeAction,
  createConversationAction,
  generateConversationTitleAction,
  renameConversationAction,
  deleteConversationAction,
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

describe('createAgentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.createConfiguredAgent.mockResolvedValue({ id: 'agent-1' });
  });

  it('lets the backend provision a sandbox for a newly created Pi agent', async () => {
    const form = new FormData();
    form.set('workspace', 'acme');
    form.set('name', 'Harness');
    form.set('runtime', 'pi');
    form.set('returnTo', '/app/acme/work');

    await createAgentAction(form);

    expect(mocks.createConfiguredAgent).toHaveBeenCalledWith(
      'workspace-1',
      {
        name: 'Harness',
        systemPrompt: null,
        providerId: null,
        providerIds: [],
        model: null,
        maxSteps: 8,
      },
      {
        deploymentIds: [],
        installedSkillIds: [],
        toolkitIds: [],
        sandboxIds: [],
      },
      { runtime: 'pi', hermesImage: '' },
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      '/app/acme/agents/agent-1?settings=agent&returnTo=%2Fapp%2Facme%2Fwork',
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/work');
  });

  it.each([undefined, 'unknown'])(
    'rejects a missing or unavailable runtime (%s)',
    async (runtime) => {
      const form = new FormData();
      form.set('workspace', 'acme');
      form.set('name', 'Harness');
      if (runtime) form.set('runtime', runtime);

      await expect(createAgentAction(form)).rejects.toThrow('Choose an available Agent runtime.');
      expect(mocks.createConfiguredAgent).not.toHaveBeenCalled();
    },
  );
});

describe('model configuration action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.syncHermesRuntime.mockResolvedValue({ status: 'stopped' });
  });

  it('updates only the selected model binding and refreshes the chat workspace', async () => {
    mocks.updateAgentModelSelection.mockResolvedValueOnce('native');
    const form = runtimeForm();
    form.set('providerId', 'provider-1');
    form.set('model', 'gpt-5');

    await expect(updateAgentModelAction({}, form)).resolves.toEqual({ savedAt: expect.any(Number) });

    expect(mocks.updateAgentModelSelection).toHaveBeenCalledWith('workspace-1', 'agent-1', ['provider-1'], 'gpt-5');
    expect(mocks.syncHermesRuntime).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/chat');
  });

  it('reports a saved model selection as a warning when Hermes projection fails', async () => {
    mocks.updateAgentModelSelection.mockResolvedValueOnce('hermes');
    mocks.syncHermesRuntime.mockResolvedValueOnce({ status: 'error', error: 'projection failed' });
    const form = runtimeForm();
    form.set('providerId', 'provider-1');
    form.set('model', 'gpt-5');

    await expect(updateAgentModelAction({}, form)).resolves.toEqual({
      warning: 'Saved, but Hermes sync failed: projection failed',
      savedAt: expect.any(Number),
    });
  });
});

describe('Hermes profile and provider actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.supportsHermesProfileChat.mockResolvedValue(true);
    mocks.ensureHermesProfileProjection.mockResolvedValue(undefined);
    mocks.bindHermesAgentModelProvider.mockResolvedValue('toolplane-provider-1');
    mocks.syncHermesRuntime.mockResolvedValue({ status: 'running' });
    mocks.listHermesProfileModels.mockResolvedValue({
      profile: 'default',
      provider: 'toolplane-provider-1',
      model: 'model-a',
      providers: [{ id: 'toolplane-provider-1', name: 'Provider', models: ['model-a'] }],
    });
    mocks.listHermesProfiles.mockResolvedValue([{
      name: 'default', isDefault: true, provider: 'openrouter', model: 'model-a', description: '',
    }]);
    mocks.setHermesConversationSelection.mockResolvedValue({
      conversationId: 'conversation-1', created: false,
    });
    mocks.runHermesRuntimeMaintenance.mockImplementation(async (...args: unknown[]) => ({
      status: 'completed',
      data: await (args[4] as (context: { requestSync: () => void }) => Promise<unknown>)({
        requestSync: mocks.requestHermesRuntimeSync,
      }),
    }));
  });

  it('changes a conversation profile only inside the runtime write barrier', async () => {
    mocks.agentFindFirst
      .mockResolvedValueOnce({
        publicRuntimeAllocation: null,
        runtime: { sandbox: { config: { managedBy: 'agent-runtime' } } },
      })
      .mockResolvedValueOnce({
        id: 'agent-1',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes', sandboxId: 'sandbox-1' },
      });
    const form = runtimeForm();
    form.set('conversationId', 'conversation-1');
    form.set('profile', 'default');
    form.set('useDefault', '1');

    await expect(updateHermesConversationSelectionAction({}, form)).resolves.toEqual({
      savedAt: expect.any(Number),
      conversationId: 'conversation-1',
      created: false,
    });
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'sandbox-1',
      { quiesce: false },
      expect.any(Function),
    );
    expect(mocks.setHermesConversationSelection).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'conversation-1',
      { profile: 'default', provider: null, model: null },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/chat');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/work');
  });

  it('binds and projects a ToolPlane provider before saving a conversation model', async () => {
    mocks.agentFindFirst
      .mockResolvedValueOnce({
        publicRuntimeAllocation: null,
        runtime: { sandbox: { config: { managedBy: 'agent-runtime' } } },
      })
      .mockResolvedValueOnce({
        id: 'agent-1',
        workspaceId: 'workspace-1',
        runtime: { id: 'runtime-1', kind: 'hermes', sandboxId: 'sandbox-1' },
      });
    const form = runtimeForm();
    form.set('conversationId', 'conversation-1');
    form.set('profile', 'default');
    form.set('provider', 'toolplane-provider-1');
    form.set('model', 'model-a');

    await expect(updateHermesConversationSelectionAction({}, form)).resolves.toEqual({
      savedAt: expect.any(Number),
      conversationId: 'conversation-1',
      created: false,
    });
    expect(mocks.bindHermesAgentModelProvider).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'toolplane-provider-1',
      'model-a',
    );
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenNthCalledWith(
      1,
      'workspace-1',
      'agent-1',
      'sandbox-1',
      { quiesce: false },
      expect.any(Function),
    );
    expect(mocks.requestHermesRuntimeSync).toHaveBeenCalledOnce();
    expect(mocks.setHermesConversationSelection).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'conversation-1',
      { profile: 'default', provider: 'toolplane-provider-1', model: 'model-a' },
    );
  });

  it('keeps a provider save successful when runtime reprojection fails', async () => {
    mocks.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'Provider',
      format: 'openai',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'secret',
    });
    mocks.agentFindMany.mockResolvedValue([{
      id: 'hermes-1',
      runtime: { sandboxId: 'sandbox-1' },
    }]);
    mocks.runHermesRuntimeMaintenance.mockResolvedValueOnce({
      status: 'error',
      error: 'projection failed',
    });
    const form = new FormData();
    form.set('workspace', 'acme');
    form.set('providerId', 'provider-1');
    form.set('name', 'Provider');
    form.set('format', 'openai');
    form.set('baseUrl', 'https://provider.test/v1');

    await expect(updateProviderAction({}, form)).resolves.toEqual({
      warning: 'Hermes sync failed: projection failed',
      savedAt: expect.any(Number),
    });
    expect(mocks.updateProvider).toHaveBeenCalled();
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenCalledWith(
      'workspace-1',
      'hermes-1',
      'sandbox-1',
      { quiesce: false, reprojectAfter: true },
      expect.any(Function),
    );
  });

  it('attempts every Hermes reprojection after an earlier Agent fails', async () => {
    mocks.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'Provider',
      format: 'openai',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'secret',
    });
    mocks.agentFindMany.mockResolvedValue([
      { id: 'hermes-1', runtime: { sandboxId: 'sandbox-1' } },
      { id: 'hermes-2', runtime: { sandboxId: 'sandbox-2' } },
    ]);
    mocks.runHermesRuntimeMaintenance
      .mockResolvedValueOnce({ status: 'error', error: 'first failed' })
      .mockResolvedValueOnce({ status: 'completed' });
    const form = new FormData();
    form.set('workspace', 'acme');
    form.set('providerId', 'provider-1');
    form.set('name', 'Provider');
    form.set('format', 'openai');
    form.set('baseUrl', 'https://provider.test/v1');

    await expect(updateProviderAction({}, form)).resolves.toEqual({
      warning: 'Hermes sync failed: first failed',
      savedAt: expect.any(Number),
    });
    expect(mocks.runHermesRuntimeMaintenance).toHaveBeenCalledTimes(2);
  });
});

describe('workspace model preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.getProvider.mockResolvedValue({ id: 'provider-1', models: ['gpt-5'] });
  });

  it('saves only a model exposed by a provider in the current workspace', async () => {
    const form = new FormData();
    form.set('workspace', 'acme');
    form.set('preference', 'title');
    form.set('providerId', 'provider-1');
    form.set('model', 'gpt-5');

    await expect(updateWorkspaceModelPreferenceAction({}, form)).resolves.toEqual({ savedAt: expect.any(Number) });
    expect(mocks.getProvider).toHaveBeenCalledWith('workspace-1', 'provider-1');
    expect(mocks.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: 'workspace-1' },
      data: { titleModelProviderId: 'provider-1', titleModel: 'gpt-5' },
    });
  });

  it('rejects a stale model and can clear the default selection', async () => {
    mocks.getProvider.mockResolvedValueOnce({ id: 'provider-1', models: ['gpt-4.1'] });
    const invalid = new FormData();
    invalid.set('workspace', 'acme');
    invalid.set('preference', 'default');
    invalid.set('providerId', 'provider-1');
    invalid.set('model', 'gpt-5');
    await expect(updateWorkspaceModelPreferenceAction({}, invalid)).resolves.toEqual({
      error: 'Choose an available model.',
    });
    expect(mocks.workspaceUpdate).not.toHaveBeenCalled();

    const clear = new FormData();
    clear.set('workspace', 'acme');
    clear.set('preference', 'default');
    await updateWorkspaceModelPreferenceAction({}, clear);
    expect(mocks.workspaceUpdate).toHaveBeenCalledWith({
      where: { id: 'workspace-1' },
      data: { defaultModelProviderId: null, defaultModel: null },
    });
  });
});

describe('conversation management actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.renameConsoleConversation.mockResolvedValue(true);
    mocks.generateConsoleConversationTitle.mockResolvedValue('Project brief');
    mocks.deleteConsoleConversation.mockResolvedValue(true);
  });

  it('renames only a workspace-owned console conversation', async () => {
    const form = runtimeForm();
    form.set('conversationId', 'conversation-1');
    form.set('title', '  Project brief  ');

    await renameConversationAction(form);

    expect(mocks.renameConsoleConversation).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'conversation-1',
      'Project brief',
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/chat');
  });

  it('generates a title through the workspace-scoped conversation helper', async () => {
    const form = runtimeForm();
    form.set('conversationId', 'conversation-1');
    form.set('force', '1');

    await expect(generateConversationTitleAction(form)).resolves.toEqual({ savedAt: expect.any(Number) });

    expect(mocks.generateConsoleConversationTitle).toHaveBeenCalledWith(
      'workspace-1',
      'agent-1',
      'conversation-1',
      true,
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/chat');
  });

  it('returns to the agent chat root after deleting a conversation', async () => {
    const form = runtimeForm();
    form.set('conversationId', 'conversation-1');
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });

    await expect(deleteConversationAction(form)).rejects.toThrow('redirect:/app/acme/chat?agent=agent-1');

    expect(mocks.deleteConsoleConversation).toHaveBeenCalledWith('workspace-1', 'agent-1', 'conversation-1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/chat');
  });
});

describe('createConversationAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizedAgent();
    mocks.createConversation.mockResolvedValue({ id: 'conversation-1' });
  });

  it('redirects a newly created conversation to the standalone chat workspace', async () => {
    const form = runtimeForm();
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });

    await expect(createConversationAction(form)).rejects.toThrow(
      'redirect:/app/acme/chat?agent=agent-1&c=conversation-1',
    );

    expect(mocks.createConversation).toHaveBeenCalledWith('workspace-1', 'agent-1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/chat');
  });
});
