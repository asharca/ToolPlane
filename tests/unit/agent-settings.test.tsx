import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentSettings } from '@/components/dashboard/agents/AgentSettings';

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
  it('renders a settings workspace without the legacy conversation UI', () => {
    render(
      <AgentSettings
        slug="acme"
        agentId="agent-1"
        settings={settings}
        channelSettings={{ connections: [] }}
        ready
        agentName="Release copilot"
      />,
    );

    expect(screen.getByText('settings:general:false')).toBeInTheDocument();
    expect(screen.queryByText('OpenAI · gpt-5')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Instructions' })).toBeInTheDocument();
    expect(screen.queryByText('Basic')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Tools$/)).not.toBeInTheDocument();
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
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(await screen.findByText('channel-settings')).toBeInTheDocument();
  });
});
