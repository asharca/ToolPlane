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
  updateAgent: vi.fn(),
  upgradeHermesRuntime: vi.fn(),
  agentFindFirst: vi.fn(),
  createConversation: vi.fn(),
  renameConsoleConversation: vi.fn(),
  generateConsoleConversationTitle: vi.fn(),
  deleteConsoleConversation: vi.fn(),
  updateAgentModelSelection: vi.fn(),
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
    agent: { findFirst: mocks.agentFindFirst },
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
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setProviderModels: vi.fn(),
  createConversation: mocks.createConversation,
  renameConsoleConversation: mocks.renameConsoleConversation,
  deleteConsoleConversation: mocks.deleteConsoleConversation,
  updateAgentModelSelection: mocks.updateAgentModelSelection,
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
  createAgentAction,
  updateAgentAction,
  updateAgentModelAction,
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
  });

  it('updates only the selected model binding and refreshes the chat workspace', async () => {
    const form = runtimeForm();
    form.set('providerId', 'provider-1');
    form.set('model', 'gpt-5');

    await expect(updateAgentModelAction({}, form)).resolves.toEqual({ savedAt: expect.any(Number) });

    expect(mocks.updateAgentModelSelection).toHaveBeenCalledWith('workspace-1', 'agent-1', ['provider-1'], 'gpt-5');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/chat');
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
