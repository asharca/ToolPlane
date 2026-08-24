import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentSettingsForm } from '@/components/dashboard/agents/AgentSettingsForm';

type FormActionMock = (_prev: unknown, formData: FormData) => Promise<{ savedAt: number }>;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const actions = vi.hoisted(() => ({
  stopAgentRuntimeAction: vi.fn(),
  syncAgentRuntimeAction: vi.fn(),
  upgradeHermesRuntimeAction: vi.fn<FormActionMock>(async () => ({ savedAt: Date.now() })),
  updateHermesRuntimeEnvAction: vi.fn<FormActionMock>(async () => ({ savedAt: Date.now() })),
  updateAgentAction: vi.fn(async () => ({ savedAt: Date.now() })),
}));

vi.mock('@/lib/agents/actions', () => actions);

const baseProps = {
  slug: 'acme',
  agentId: 'agent-1',
  name: 'Test agent',
  systemPrompt: '',
  providerId: null,
  providerIds: [],
  model: null,
  maxSteps: 8,
  providers: [
    {
      id: 'provider-1',
      name: 'OpenAI',
      models: ['gpt-4.1', 'gpt-4.1-mini'],
    },
  ],
  deployments: [],
  skills: [],
  toolkits: [],
  sandboxes: [],
  subAgents: [],
};

describe('AgentSettingsForm', () => {
  it('keeps the selected provider and model visible across save-state rerenders', async () => {
    const view = render(<AgentSettingsForm {...baseProps} />);

    const provider = screen.getByLabelText('Provider');
    await userEvent.selectOptions(provider, 'provider-1');

    const model = screen.getByLabelText('Model');
    await userEvent.selectOptions(model, 'gpt-4.1-mini');

    expect(provider).toHaveValue('provider-1');
    expect(model).toHaveValue('gpt-4.1-mini');

    view.rerender(<AgentSettingsForm {...baseProps} />);

    expect(screen.getByLabelText('Provider')).toHaveValue('provider-1');
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-4.1-mini');
    expect(screen.getByLabelText('System prompt')).toBeInTheDocument();
  });

  it('does not expose a ToolPlane system prompt field for Hermes agents', () => {
    render(
      <AgentSettingsForm
        {...baseProps}
        systemPrompt="Legacy ToolPlane prompt"
        runtime={{
          kind: 'hermes',
          image: 'nousresearch/hermes-agent:latest',
          status: 'running',
          lastError: null,
          lastSyncedAt: null,
          sandboxId: 'sandbox-1',
        }}
      />,
    );

    expect(screen.queryByLabelText('System prompt')).not.toBeInTheDocument();
    expect(document.querySelector('[name="systemPrompt"]')).toBeNull();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('lets Hermes agents select multiple providers without selecting a model', async () => {
    render(
      <AgentSettingsForm
        {...baseProps}
        providers={[
          ...baseProps.providers,
          { id: 'provider-2', name: 'Anthropic', models: ['claude-sonnet'] },
        ]}
        providerIds={['provider-1']}
        runtime={{
          kind: 'hermes',
          image: 'nousresearch/hermes-agent:latest',
          status: 'running',
          lastError: null,
          lastSyncedAt: null,
          sandboxId: 'sandbox-1',
        }}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Select OpenAI' })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Anthropic' }));
    expect(document.querySelectorAll('input[name="providerId"]')).toHaveLength(2);
    expect(document.querySelector('[name="model"]')).toBeNull();
  });

  it('edits the Hermes volume environment separately from agent autosave', async () => {
    render(
      <AgentSettingsForm
        {...baseProps}
        runtime={{
          kind: 'hermes',
          image: 'nousresearch/hermes-agent:latest',
          status: 'running',
          lastError: null,
          lastSyncedAt: null,
          sandboxId: 'sandbox-1',
          environment: 'EXISTING=value',
        }}
      />,
    );

    const environment = screen.getByLabelText('Hermes environment variables');
    expect(environment).toHaveValue('EXISTING=value');
    await userEvent.clear(environment);
    await userEvent.type(environment, 'API_KEY=secret');

    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save environment' }));
    await waitFor(() => expect(actions.updateHermesRuntimeEnvAction).toHaveBeenCalled());
    const formData = actions.updateHermesRuntimeEnvAction.mock.calls.at(-1)?.[1];
    expect(formData).toBeInstanceOf(FormData);
    if (!formData) throw new Error('Environment form was not submitted.');
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('agentId')).toBe('agent-1');
    expect(formData.get('hermesEnv')).toBe('API_KEY=secret');
  });

  it('upgrades Hermes with the selected image through its dedicated action', async () => {
    actions.upgradeHermesRuntimeAction.mockClear();
    actions.updateAgentAction.mockClear();
    render(
      <AgentSettingsForm
        {...baseProps}
        hermesImages={[
          'nousresearch/hermes-agent:latest',
          'nousresearch/hermes-agent:v2026.7.20',
        ]}
        runtime={{
          kind: 'hermes',
          image: 'nousresearch/hermes-agent:latest',
          status: 'running',
          lastError: null,
          lastSyncedAt: null,
          sandboxId: 'sandbox-1',
        }}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText('Hermes version'),
      'nousresearch/hermes-agent:v2026.7.20',
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 800));
    expect(actions.updateAgentAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade & restart' }));
    await waitFor(() => expect(actions.upgradeHermesRuntimeAction).toHaveBeenCalled());
    const formData = actions.upgradeHermesRuntimeAction.mock.calls.at(-1)?.[1];
    expect(formData).toBeInstanceOf(FormData);
    if (!formData) throw new Error('Hermes upgrade form was not submitted.');
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('agentId')).toBe('agent-1');
    expect(formData.get('hermesImage')).toBe('nousresearch/hermes-agent:v2026.7.20');
  });

  it('shows pending and completed feedback for Hermes sync and stop actions', async () => {
    let finishSync: ((state: { savedAt: number }) => void) | undefined;
    let finishStop: ((state: { savedAt: number }) => void) | undefined;
    actions.syncAgentRuntimeAction.mockImplementation(
      () => new Promise((resolve) => { finishSync = resolve; }),
    );
    actions.stopAgentRuntimeAction.mockImplementation(
      () => new Promise((resolve) => { finishStop = resolve; }),
    );
    render(
      <AgentSettingsForm
        {...baseProps}
        runtime={{
          kind: 'hermes',
          image: 'nousresearch/hermes-agent:latest',
          status: 'running',
          lastError: null,
          lastSyncedAt: null,
          sandboxId: 'sandbox-1',
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sync / start' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Syncing...' })).toBeDisabled());
    finishSync?.({ savedAt: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Synced' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stopping...' })).toBeDisabled());
    finishStop?.({ savedAt: 2 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stopped' })).toBeEnabled());
  });

  it('does not save searches but saves resource changes', async () => {
    const user = userEvent.setup();
    actions.updateAgentAction.mockClear();
    render(
      <AgentSettingsForm
        {...baseProps}
        deployments={[
          {
            id: 'deployment-1',
            label: 'RouterOS MCP',
            checked: false,
            description: 'Network automation',
            source: 'custom',
            status: 'running',
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^MCP/ }));
    await user.type(screen.getByRole('searchbox', { name: 'Search MCP...' }), 'router');
    await new Promise<void>((resolve) => window.setTimeout(resolve, 800));
    expect(actions.updateAgentAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: 'Select RouterOS MCP' }));
    await waitFor(() => expect(actions.updateAgentAction).toHaveBeenCalled(), { timeout: 1_500 });
  });

  it('flushes a pending autosave before focus leaves the settings form', async () => {
    actions.updateAgentAction.mockClear();
    render(
      <div>
        <AgentSettingsForm {...baseProps} />
        <button type="button">Close settings</button>
      </div>,
    );

    await userEvent.type(screen.getByLabelText('Name'), ' updated');
    expect(actions.updateAgentAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    await waitFor(() => expect(actions.updateAgentAction).toHaveBeenCalledOnce());
  });

  it('supports a controlled section with its internal navigation hidden', () => {
    const props = {
      ...baseProps,
      systemPrompt: 'Use the workspace tools carefully.',
      deployments: [{ id: 'deployment-1', label: 'RouterOS MCP', checked: true }],
      skills: [{ id: 'skill-1', label: 'Network skill', checked: true }],
      activeSection: 'mcp' as const,
      showNavigation: false,
    };
    const view = render(<AgentSettingsForm {...props} />);

    expect(screen.queryByRole('navigation', { name: 'Configuration navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select RouterOS MCP' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save now' })).not.toBeInTheDocument();

    const form = document.querySelector('form');
    if (!form) throw new Error('Expected settings form.');
    expect(new FormData(form).getAll('installedSkillId')).toEqual(['skill-1']);

    view.rerender(<AgentSettingsForm {...props} activeSection="skills" />);
    expect(screen.getByRole('checkbox', { name: 'Select Network skill' })).toBeVisible();
  });

  it('notifies the parent when a controlled section is selected', async () => {
    const onSectionChange = vi.fn();
    render(
      <AgentSettingsForm
        {...baseProps}
        activeSection="mcp"
        onSectionChange={onSectionChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^Skills/ }));
    expect(onSectionChange).toHaveBeenCalledWith('skills');
  });

  it('keeps form values and resource bindings mounted while navigating settings sections', async () => {
    const user = userEvent.setup();
    render(
      <AgentSettingsForm
        {...baseProps}
        systemPrompt="Use the workspace tools carefully."
        providerId="provider-1"
        model="gpt-4.1"
        deployments={[{ id: 'deployment-1', label: 'RouterOS MCP', checked: true }]}
        skills={[{ id: 'skill-1', label: 'Network skill', checked: true }]}
        toolkits={[{ id: 'toolkit-1', label: 'Ops toolkit', checked: true }]}
        sandboxes={[{ id: 'sandbox-1', label: 'Workspace', checked: true }]}
        subAgents={[{ id: 'agent-2', label: 'Reviewer', checked: true }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^MCP/ }));
    await user.click(screen.getByRole('button', { name: /^Skills/ }));
    await user.click(screen.getByRole('button', { name: /^Advanced$/ }));

    const form = document.querySelector('form');
    if (!form) throw new Error('Expected settings form.');
    const formData = new FormData(form);
    expect(formData.get('name')).toBe('Test agent');
    expect(formData.get('systemPrompt')).toBe('Use the workspace tools carefully.');
    expect(formData.get('providerId')).toBe('provider-1');
    expect(formData.get('model')).toBe('gpt-4.1');
    expect(formData.get('maxSteps')).toBe('8');
    expect(formData.getAll('deploymentId')).toEqual(['deployment-1']);
    expect(formData.getAll('installedSkillId')).toEqual(['skill-1']);
    expect(formData.getAll('toolkitId')).toEqual(['toolkit-1']);
    expect(formData.getAll('sandboxId')).toEqual(['sandbox-1']);
    expect(formData.getAll('subAgentId')).toEqual(['agent-2']);
  });
});
