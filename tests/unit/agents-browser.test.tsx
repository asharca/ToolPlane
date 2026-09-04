import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsBrowser } from '@/components/dashboard/agents/AgentsBrowser';

const actions = vi.hoisted(() => ({
  cloneAgentAction: vi.fn(),
  createAgentAction: vi.fn(),
  deleteAgentAction: vi.fn(),
  installAgentFromMarketAction: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ search: '__dashboardTab=agents-tab', push: vi.fn() }));
const configuredCreateOptions = {
  providers: [{ id: 'provider-1', name: 'OpenAI', format: 'openai', models: ['gpt-4.1'] }],
  defaultModel: { providerId: 'provider-1', model: 'gpt-4.1' },
  deployments: [],
  skills: [],
  toolkits: [],
};

vi.mock('@/lib/agents/actions', () => actions);
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/acme/agents',
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

async function openBlankCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New agent' }));
}

describe('AgentsBrowser', () => {
  beforeEach(() => {
    actions.cloneAgentAction.mockReset();
    actions.createAgentAction.mockReset();
    actions.deleteAgentAction.mockReset();
    actions.installAgentFromMarketAction.mockReset();
    navigation.search = '__dashboardTab=agents-tab';
    navigation.push.mockReset();
  });

  it('opens the blank form directly from Work and preserves its return path', () => {
    navigation.search = 'create=1&returnTo=%2Fapp%2Facme%2Fwork';
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a blank agent' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Choose from the agent market' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('link', { name: 'Choose from the agent market' })).not.toBeInTheDocument();
    expect(document.querySelector('#agent-create-source')).not.toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>('input[name="returnTo"]')).toHaveValue('/app/acme/work');
    expect(screen.getByText('Add a model provider before expecting replies')).toBeInTheDocument();
  });

  it('shows and installs agent market data inside the creator', async () => {
    const user = userEvent.setup();
    navigation.search = 'create=1&returnTo=%2Fapp%2Facme%2Fwork';
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
        marketAgents={[{
          id: 'listing-1',
          releaseId: 'release-1',
          idempotencyKey: 'request-1',
          name: 'Market researcher',
          summary: 'Researches primary sources.',
          iconUrl: null,
          publisher: 'ToolPlane',
          tags: ['research'],
          runtimes: ['hermes'],
          resourceCount: 3,
          sandboxCount: 1,
          installCount: 12,
        }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Choose from the agent market' }));
    expect(screen.getByText('Market researcher')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Market researcher/ })).not.toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>('input[name="releaseId"]')).toHaveValue('release-1');
    expect(document.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')).toHaveValue('request-1');
    expect(document.querySelector<HTMLInputElement>('input[name="returnTo"]')).toHaveValue(
      '/app/acme/agents?create=1&returnTo=%2Fapp%2Facme%2Fwork&source=market',
    );
  });

  it('keeps the Work add flow focused on creation instead of existing Agent management', () => {
    navigation.search = 'create=1&returnTo=%2Fapp%2Facme%2Fwork';
    render(
      <AgentsBrowser
        slug="acme"
        agents={[{
          id: 'agent-1', name: 'Existing Agent', providerName: 'OpenAI', providerNames: [],
          model: 'gpt-5', toolCount: 0, subAgentCount: 0, runtimeKind: 'pi',
          runtimeStatus: 'running', sandboxReady: true,
        }]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.queryByText('Existing Agent')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete agent' })).not.toBeInTheDocument();
  });

  it('cancels the Work create-only flow back to its caller', async () => {
    const user = userEvent.setup();
    navigation.search = 'create=1&returnTo=%2Fapp%2Facme%2Fwork';
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(navigation.push).toHaveBeenCalledWith('/app/acme/work');
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

  it('defaults to Claude Code and requires a configured model before advancing', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={configuredCreateOptions}
      />,
    );

    await openBlankCreate(user);
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /DeepSeek Harness/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /^Pi/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /Hermes managed runtime/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Create draft agent' })).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: /Basic/ })).toHaveAttribute('aria-current', 'step');

    await user.type(screen.getByLabelText('Name'), 'Research agent');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled();
    expect(screen.getByText(/dedicated Docker sandbox is created automatically/i)).toBeInTheDocument();
  });

  it('filters harness providers and provisions its sandbox automatically', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{
          ...configuredCreateOptions,
          providers: [
            { id: 'provider-1', name: 'OpenAI', format: 'openai', models: ['gpt-4.1'] },
            { id: 'responses', name: 'Responses', format: 'openai-responses', models: ['gpt-5.6-luna'] },
            { id: 'anthropic', name: 'Anthropic', format: 'anthropic', models: ['claude-sonnet'] },
            { id: 'pi-native', name: 'Pi native', format: 'pi:openai', models: ['gpt-native'] },
          ],
        }}
      />,
    );

    await openBlankCreate(user);
    await user.type(screen.getByLabelText('Name'), 'Harness agent');
    await user.click(screen.getByRole('button', { name: 'Model: gpt-4.1' }));
    const picker = screen.getByRole('listbox', { name: 'Select model' });
    expect(within(picker).getByRole('group', { name: 'Anthropic' })).toBeInTheDocument();
    expect(within(picker).getByRole('group', { name: 'OpenAI' })).toBeInTheDocument();
    expect(within(picker).getByRole('group', { name: 'Responses' })).toBeInTheDocument();
    expect(within(picker).queryByRole('group', { name: 'Pi native' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('input[name="sandboxId"]')).toHaveLength(0);

    await user.click(screen.getByRole('radio', { name: /DeepSeek Harness/ }));
    await user.click(screen.getByRole('button', { name: 'Model: gpt-4.1' }));
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Pi native' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^Pi/ }));
    await user.click(screen.getByRole('button', { name: 'Model: gpt-4.1' }));
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Pi native' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('System prompt')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create draft agent' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled();
  }, 15_000);

  it('labels the open form as cancellable and clears its controlled draft state', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={{
          ...configuredCreateOptions,
          deployments: [{ id: 'deployment-1', label: 'Router MCP' }],
        }}
      />,
    );

    await openBlankCreate(user);
    await user.click(screen.getByRole('radio', { name: /^Pi/ }));
    await user.type(screen.getByLabelText('Name'), 'Research agent');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Router MCP' }));

    const form = document.querySelector<HTMLElement>('#agent-create-form');
    expect(form).not.toBeNull();
    const cancel = within(form!).getByRole('button', { name: 'Cancel' });
    await user.click(cancel);

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await openBlankCreate(user);
    await user.click(screen.getByRole('radio', { name: /^Pi/ }));
    expect(screen.getByRole('button', { name: 'Model: gpt-4.1' })).toBeInTheDocument();
    expect(document.querySelector('input[name="providerId"]')).toHaveValue('provider-1');
    await user.type(screen.getByLabelText('Name'), 'Second agent');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('checkbox', { name: 'Select Router MCP' })).not.toBeChecked();
  }, 15_000);

  it('tracks the current create step and preserves the name when going back', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={configuredCreateOptions}
      />,
    );

    await openBlankCreate(user);
    const basicStep = screen.getByRole('button', { name: /Basic/ });
    expect(basicStep).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toBeChecked();
    await user.type(screen.getByLabelText('Name'), 'Research agent');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: /Instructions/ })).toHaveAttribute('aria-current', 'step');
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(basicStep).toHaveAttribute('aria-current', 'step');
    expect(screen.getByLabelText('Name')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('Research agent');

    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
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
        createOptions={configuredCreateOptions}
      />,
    );

    await openBlankCreate(userEvent.setup());
    await userEvent.type(screen.getByLabelText('Name'), 'Research agent');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    const maxSteps = screen.getByRole('spinbutton', { name: 'Maximum tool-call rounds' });
    await userEvent.clear(maxSteps);
    await userEvent.type(maxSteps, '42');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled());
    const formData = actions.createAgentAction.mock.calls[0]?.[0] as FormData;
    expect(formData.get('maxSteps')).toBe('42');
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
            { id: 'provider-1', name: 'OpenAI', format: 'openai', models: ['gpt-4.1'] },
            { id: 'provider-2', name: 'Anthropic', format: 'anthropic', models: ['claude-sonnet'] },
          ],
          deployments: [],
          skills: [],
          toolkits: [],
        }}
      />,
    );

    await openBlankCreate(userEvent.setup());
    await userEvent.click(screen.getByRole('radio', { name: /Hermes managed runtime/ }));
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
        createOptions={configuredCreateOptions}
      />,
    );

    await openBlankCreate(user);
    await user.click(screen.getByRole('radio', { name: /Hermes managed runtime/ }));
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
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(actions.createAgentAction).toHaveBeenCalledOnce());
    const formData = actions.createAgentAction.mock.calls[0][0] as FormData;
    expect(formData.get('hermesImage')).toBe('registry.example/hermes:v2026.8.1');
  });

  it('lets the backend provision a sandbox when creating a Pi agent', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={configuredCreateOptions}
      />,
    );

    await openBlankCreate(user);
    await user.click(screen.getByRole('radio', { name: /^Pi/ }));
    await user.type(screen.getByLabelText('Name'), 'Harness');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(actions.createAgentAction).toHaveBeenCalledOnce());
    const formData = actions.createAgentAction.mock.calls[0][0] as FormData;
    expect(formData.get('runtime')).toBe('pi');
    expect(formData.getAll('sandboxId')).toEqual([]);
  });

  it('includes an optional system prompt for a Pi agent', async () => {
    const user = userEvent.setup();
    render(
      <AgentsBrowser
        slug="acme"
        agents={[]}
        createOptions={configuredCreateOptions}
      />,
    );

    await openBlankCreate(user);
    await user.click(screen.getByRole('radio', { name: /^Pi/ }));
    await user.type(screen.getByLabelText('Name'), 'Researcher');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('System prompt'), 'Use sources carefully.');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

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
        createOptions={configuredCreateOptions}
      />,
    );

    await openBlankCreate(user);
    await user.click(screen.getByRole('radio', { name: /Hermes managed runtime/ }));
    await user.type(screen.getByLabelText('Name'), 'Pinned Hermes');
    await user.selectOptions(
      screen.getByLabelText('Hermes version'),
      'nousresearch/hermes-agent:v2026.7.20',
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

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
            runtimeKind: 'pi',
            runtimeStatus: null,
            sandboxReady: true,
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
            sandboxReady: false,
          },
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    const row = screen.getByRole('link', { name: 'Hermes researcher' }).closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Ready')).toBeInTheDocument();
    expect(within(row!).getByText(/2 selected: OpenAI, Anthropic/)).toBeInTheDocument();
    expect(within(row!).getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'href',
      '/app/acme/chat?agent=agent-hermes',
    );
  });

  it('shows the stored runtime instead of relabeling it as Pi', () => {
    render(
      <AgentsBrowser
        slug="acme"
        agents={[{
          id: 'agent-dsh',
          name: 'Harness agent',
          providerName: 'OpenAI',
          providerNames: [],
          model: 'gpt-4.1',
          toolCount: 0,
          subAgentCount: 0,
          runtimeKind: 'dsh',
          runtimeStatus: null,
          sandboxReady: false,
        }]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    const row = screen.getByRole('link', { name: 'Harness agent' }).closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('DeepSeek Harness')).toBeInTheDocument();
    expect(within(row!).getByText('needs sandbox')).toBeInTheDocument();
    expect(within(row!).queryByText('Ready')).not.toBeInTheDocument();
  });

  it('requires a new sandbox instead of cloning a dedicated-runtime agent', async () => {
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
            runtimeKind: 'pi',
            runtimeStatus: null,
            sandboxReady: true,
          },
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    const settingsButton = screen.getByRole('link', { name: 'Settings' });
    const cloneButton = screen.getByRole('button', {
      name: 'Create a new agent and select an unassigned sandbox',
    });
    const deleteButton = screen.getByRole('button', { name: 'Delete agent' });
    expect(settingsButton).toHaveAttribute('title', 'Settings');
    expect(cloneButton).toBeDisabled();
    expect(cloneButton).toHaveAttribute(
      'title',
      'Create a new agent and select an unassigned sandbox',
    );
    expect(deleteButton).toHaveAttribute('title', 'Delete agent');

    await user.click(deleteButton);
    expect(screen.getByText('Delete this agent, its sandboxes, and all its conversations?')).toBeInTheDocument();
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
            sandboxReady: false,
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
    await user.click(conversations);
    expect(volume).toBeChecked();
    await user.click(volume);
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
