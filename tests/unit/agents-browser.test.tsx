import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsBrowser } from '@/components/dashboard/agents/AgentsBrowser';

const actions = vi.hoisted(() => ({
  cloneAgentAction: vi.fn(),
  createAgentAction: vi.fn(),
  deleteAgentAction: vi.fn(),
}));

vi.mock('@/lib/agents/actions', () => actions);
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/acme/agents',
  useSearchParams: () => new URLSearchParams('__dashboardTab=agents-tab'),
}));

describe('AgentsBrowser', () => {
  beforeEach(() => {
    actions.cloneAgentAction.mockReset();
    actions.createAgentAction.mockReset();
    actions.deleteAgentAction.mockReset();
  });

  it('keeps the market entry inside the authenticated workspace console', () => {
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    expect(screen.getByRole('link', { name: 'Browse market' })).toHaveAttribute(
      'href',
      '/app/acme/market/agents',
    );
  });

  it('labels the open form as cancellable and clears its controlled draft state', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{
          providers: [{ id: 'provider-1', name: 'OpenAI', models: ['gpt-4.1'] }],
          deployments: [{ id: 'deployment-1', label: 'Router MCP' }],
          skills: [],
          toolkits: [],
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.selectOptions(screen.getByLabelText('Provider'), 'provider-1');
    await user.click(screen.getByRole('checkbox', { name: 'Select Router MCP' }));

    const cancel = screen.getByRole('button', { name: 'Cancel', expanded: true });
    await user.click(cancel);

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    expect(screen.getByLabelText('Provider')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Select Router MCP' })).not.toBeChecked();
  });

  it('shows progress and completion feedback while creating an agent', async () => {
    let finishCreate: (() => void) | undefined;
    actions.createAgentAction.mockImplementation(
      () => new Promise<void>((resolve) => { finishCreate = resolve; }),
    );
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New agent' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Research agent');
    await userEvent.click(screen.getByRole('button', { name: 'Create draft agent' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled());
    finishCreate?.();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Created' })).toBeEnabled());
  });

  it('offers multiple providers and no model picker for a Hermes agent', async () => {
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{
          providers: [
            { id: 'provider-1', name: 'OpenAI', models: ['gpt-4.1'] },
            { id: 'provider-2', name: 'Anthropic', models: ['claude-sonnet'] },
          ],
          deployments: [],
          skills: [],
          toolkits: [],
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New agent' }));
    await userEvent.click(screen.getByText('Hermes'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select OpenAI' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Anthropic' }));

    expect(document.querySelectorAll('input[name="providerId"]')).toHaveLength(2);
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('lets a Hermes deployment choose an official version or a custom image', async () => {
    const user = userEvent.setup();
    actions.createAgentAction.mockClear();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        hermesImages={[
          'nousresearch/hermes-agent:latest',
          'nousresearch/hermes-agent:v2026.7.20',
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByText('Hermes'));
    const version = screen.getByLabelText('Hermes version');
    expect(version).toHaveValue('nousresearch/hermes-agent:latest');
    expect(screen.getByRole('option', { name: 'nousresearch/hermes-agent:v2026.7.20' })).toBeInTheDocument();

    await user.selectOptions(version, 'nousresearch/hermes-agent:v2026.7.20');
    expect(document.querySelector<HTMLInputElement>('input[name="hermesImage"]')).toHaveValue(
      'nousresearch/hermes-agent:v2026.7.20',
    );

    await user.selectOptions(version, '__custom__');
    const customImage = screen.getByLabelText('Custom image / version');
    await user.type(customImage, 'registry.example/hermes:v2026.8.1');
    expect(document.querySelector<HTMLInputElement>('input[name="hermesImage"]')).toHaveValue(
      'registry.example/hermes:v2026.8.1',
    );
    await user.type(screen.getByLabelText('Name'), 'Custom Hermes');
    await user.click(screen.getByRole('button', { name: 'Create draft agent' }));
    await waitFor(() => expect(actions.createAgentAction).toHaveBeenCalledOnce());
    const formData = actions.createAgentAction.mock.calls[0][0] as FormData;
    expect(formData.get('hermesImage')).toBe('registry.example/hermes:v2026.8.1');
  });

  it('binds a sandbox when creating a native harness agent', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{
          providers: [],
          deployments: [],
          skills: [],
          toolkits: [],
          sandboxes: [{ id: 'sandbox-1', label: 'Coding workspace', status: 'running' }],
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Coding workspace' }));
    await user.type(screen.getByLabelText('Name'), 'Harness');
    await user.click(screen.getByRole('button', { name: 'Create draft agent' }));

    await waitFor(() => expect(actions.createAgentAction).toHaveBeenCalledOnce());
    const formData = actions.createAgentAction.mock.calls[0][0] as FormData;
    expect(formData.getAll('sandboxId')).toEqual(['sandbox-1']);
  });

  it('includes an optional system prompt for a native agent', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.type(screen.getByLabelText('Name'), 'Researcher');
    await user.type(screen.getByLabelText('System prompt'), 'Use sources carefully.');
    await user.click(screen.getByRole('button', { name: 'Create draft agent' }));

    await waitFor(() => expect(actions.createAgentAction).toHaveBeenCalledOnce());
    const formData = actions.createAgentAction.mock.calls[0][0] as FormData;
    expect(formData.get('systemPrompt')).toBe('Use sources carefully.');
  });

  it('submits the selected pinned Hermes version when creating an agent', async () => {
    const user = userEvent.setup();
    actions.createAgentAction.mockClear();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        hermesImages={[
          'nousresearch/hermes-agent:latest',
          'nousresearch/hermes-agent:v2026.7.20',
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'New agent' }));
    await user.click(screen.getByText('Hermes'));
    await user.type(screen.getByLabelText('Name'), 'Pinned Hermes');
    await user.selectOptions(
      screen.getByLabelText('Hermes version'),
      'nousresearch/hermes-agent:v2026.7.20',
    );
    await user.click(screen.getByRole('button', { name: 'Create draft agent' }));

    await waitFor(() => expect(actions.createAgentAction).toHaveBeenCalledOnce());
    const formData = actions.createAgentAction.mock.calls[0][0] as FormData;
    expect(formData.get('hermesImage')).toBe('nousresearch/hermes-agent:v2026.7.20');
  });

  it('requires both a provider and model before marking an agent ready', () => {
    render(
      <AgentsBrowser
        slug="acme"
        agents={[
          {
            id: 'agent-1',
            name: 'Orphaned model',
            providerName: null,
            providerNames: [],
            model: 'gpt-4.1',
            toolCount: 0,
            subAgentCount: 0,
            runtimeKind: 'native',
            runtimeStatus: null,
          },
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    expect(screen.getByText('Agents awaiting complete model setup: 1.')).toBeInTheDocument();
    const row = screen.getByRole('link', { name: 'Orphaned model' }).closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('needs provider')).toBeInTheDocument();
    expect(within(row!).queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Orphaned model' })).toHaveAttribute(
      'href',
      '/app/acme/agents/agent-1?returnTo=%2Fapp%2Facme%2Fagents%3F__dashboardTab%3Dagents-tab',
    );
  });

  it('marks a Hermes agent ready from its provider inventory without a fixed model', () => {
    render(
      <AgentsBrowser
        slug="acme"
        agents={[
          {
            id: 'agent-hermes',
            name: 'Hermes researcher',
            providerName: null,
            providerNames: ['OpenAI', 'Anthropic'],
            model: null,
            toolCount: 0,
            subAgentCount: 0,
            runtimeKind: 'hermes',
            runtimeStatus: 'running',
          },
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    const row = screen.getByRole('link', { name: 'Hermes researcher' }).closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Ready')).toBeInTheDocument();
    expect(within(row!).getByText(/2 selected: OpenAI, Anthropic/)).toBeInTheDocument();
  });

  it('offers clone and confirmed delete actions for each agent', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[
          {
            id: 'agent-1',
            name: 'Researcher',
            providerName: 'OpenAI',
            providerNames: [],
            model: 'gpt-4.1',
            toolCount: 2,
            subAgentCount: 1,
            runtimeKind: 'native',
            runtimeStatus: null,
          },
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Clone agent' }));
    const cloneDialog = screen.getByRole('dialog', { name: 'Clone agent' });
    const cloneForm = within(cloneDialog).getByRole('button', { name: 'Clone agent' }).closest('form');
    expect(cloneForm).not.toBeNull();
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="workspace"]')).toHaveValue('acme');
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="agentId"]')).toHaveValue('agent-1');
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="cloneName"]')).toHaveValue('Researcher copy');
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="cloneOptions"]')).toHaveValue('1');
    expect(within(cloneDialog).getByRole('checkbox', { name: /^MCP bindings/ })).toBeChecked();
    expect(within(cloneDialog).getByRole('checkbox', { name: /^Conversations and messages/ })).not.toBeChecked();

    await user.click(within(cloneDialog).getByRole('button', { name: 'Select complete clone' }));
    expect(within(cloneDialog).getByRole('checkbox', { name: /^Conversations and messages/ })).toBeChecked();
    await user.click(within(cloneDialog).getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: 'Delete agent' }));
    expect(screen.getByText('Delete this agent and all its conversations?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toHaveFocus();
  });

  it('offers Hermes state options and includes them in a complete clone', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[
          {
            id: 'agent-hermes',
            name: 'Hermes researcher',
            providerName: null,
            providerNames: ['OpenAI'],
            model: null,
            toolCount: 0,
            subAgentCount: 0,
            runtimeKind: 'hermes',
            runtimeStatus: 'stopped',
          },
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Clone agent' }));
    const cloneDialog = screen.getByRole('dialog', { name: 'Clone agent' });
    const environment = within(cloneDialog).getByRole('checkbox', { name: /^Hermes environment variables/ });
    const volume = within(cloneDialog).getByRole('checkbox', { name: /^Hermes persistent volume/ });
    const conversations = within(cloneDialog).getByRole('checkbox', { name: /^Conversations and messages/ });

    expect(environment).not.toBeChecked();
    expect(volume).not.toBeChecked();
    expect(conversations).not.toBeChecked();
    await user.click(volume);
    expect(conversations).toBeChecked();
    expect(screen.getByText('Conversations are included to preserve attachment and Hermes session references.')).toBeInTheDocument();
    await user.click(within(cloneDialog).getByRole('button', { name: 'Select complete clone' }));
    expect(environment).toBeChecked();
    expect(volume).toBeChecked();

    await user.click(within(cloneDialog).getByRole('button', { name: 'Clone agent' }));
    await waitFor(() => expect(actions.cloneAgentAction).toHaveBeenCalledOnce());
    const formData = actions.cloneAgentAction.mock.calls[0][0] as FormData;
    expect(formData.get('copyConversations')).toBe('on');
    expect(formData.get('copyHermesEnvironment')).toBe('on');
    expect(formData.get('copyHermesVolume')).toBe('on');
  });
});
