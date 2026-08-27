import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentSettings } from '@/components/dashboard/agents/AgentSettings';

vi.mock('@/lib/sandboxes/actions', () => ({ startSandboxAction: vi.fn() }));

vi.mock('@/components/dashboard/agents/AgentSettingsForm', () => ({
  AgentSettingsForm: ({
    activeSection,
    showNavigation,
  }: {
    activeSection: string;
    showNavigation: boolean;
  }) => <div>{`settings:${activeSection}:${showNavigation}`}</div>,
}));

vi.mock('@/components/dashboard/agents/AgentMessagingPanel', () => ({
  AgentMessagingPanel: () => <div>channel-settings</div>,
}));

const settings = {
  name: 'Release copilot',
  runtimeKind: 'pi',
  systemPrompt: '',
  providerId: 'provider-1',
  providerIds: [],
  model: 'gpt-5',
  maxSteps: 8,
  providers: [{ id: 'provider-1', name: 'OpenAI', format: 'openai', models: ['gpt-5'] }],
  deployments: [],
  skills: [],
  toolkits: [],
  sandboxes: [],
  subAgents: [],
};

describe('AgentSettings', () => {
  it('reports a missing dedicated sandbox before model readiness', () => {
    render(
      <AgentSettings
        slug="acme"
        agentId="agent-1"
        settings={settings}
        channelSettings={{ connections: [] }}
        ready={false}
        agentName="Release copilot"
        providerLabel="OpenAI · gpt-5"
      />,
    );

    expect(screen.getByText('needs sandbox')).toBeInTheDocument();
  });

  it('offers to start the selected sandbox when it is stopped', () => {
    render(
      <AgentSettings
        slug="acme"
        agentId="agent-1"
        settings={{
          ...settings,
          sandboxes: [{
            id: 'sandbox-1',
            label: 'Workspace',
            kind: 'docker',
            network: 'isolated',
            checked: true,
            status: 'stopped',
          }],
        }}
        channelSettings={{ connections: [] }}
        ready
        agentName="Release copilot"
        providerLabel="OpenAI · gpt-5"
      />,
    );

    const start = screen.getByRole('button', { name: 'Start' });
    expect(start.closest('form')?.querySelector('input[name="sandboxId"]')).toHaveValue('sandbox-1');
  });

  it('renders a settings workspace without the legacy conversation UI', () => {
    render(
      <AgentSettings
        slug="acme"
        agentId="agent-1"
        settings={settings}
        channelSettings={{ connections: [] }}
        ready
        agentName="Release copilot"
        providerLabel="OpenAI · gpt-5"
      />,
    );

    expect(screen.getByText('settings:general:false')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'href',
      '/app/acme/chat?agent=agent-1',
    );
    expect(screen.getByRole('button', { name: 'Instructions' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Built-in tools' }));
    expect(screen.getByText('settings:builtInTools:false')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Message this agent')).not.toBeInTheDocument();
    expect(screen.queryByText('New chat')).not.toBeInTheDocument();
  });

  it('keeps channels inside the same settings navigation', async () => {
    render(
      <AgentSettings
        slug="acme"
        agentId="agent-1"
        settings={settings}
        channelSettings={{ connections: [] }}
        ready
        agentName="Release copilot"
        providerLabel="OpenAI · gpt-5"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(await screen.findByText('channel-settings')).toBeInTheDocument();
  });
});
