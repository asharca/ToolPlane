import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentSettingsForm } from '@/components/dashboard/agents/AgentSettingsForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const actions = vi.hoisted(() => ({
  stopAgentRuntimeAction: vi.fn(),
  syncAgentRuntimeAction: vi.fn(),
  updateHermesRuntimeEnvAction: vi.fn(async () => ({ savedAt: Date.now() })),
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
    expect(screen.getByText('Auto-save is on')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save environment' }));
    await waitFor(() => expect(actions.updateHermesRuntimeEnvAction).toHaveBeenCalled());
    const formData = actions.updateHermesRuntimeEnvAction.mock.calls.at(-1)?.[1];
    expect(formData).toBeInstanceOf(FormData);
    if (!formData) throw new Error('Environment form was not submitted.');
    expect(formData.get('workspace')).toBe('acme');
    expect(formData.get('agentId')).toBe('agent-1');
    expect(formData.get('hermesEnv')).toBe('API_KEY=secret');
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

    await userEvent.click(screen.getByRole('button', { name: 'Sync / start' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Syncing...' })).toBeDisabled());
    finishSync?.({ savedAt: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Synced' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stopping...' })).toBeDisabled());
    finishStop?.({ savedAt: 2 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stopped' })).toBeEnabled());
  });

  it('does not mark search changes dirty but schedules a save for resource changes', async () => {
    const user = userEvent.setup();
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

    expect(screen.getByText('Auto-save is on')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search MCP...' }), 'router');
    expect(screen.getByText('Auto-save is on')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select RouterOS MCP' }));
    expect(screen.getByText('Saving shortly...')).toBeInTheDocument();
  });
});
