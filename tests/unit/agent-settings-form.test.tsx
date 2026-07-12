import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentSettingsForm } from '@/components/dashboard/agents/AgentSettingsForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/lib/agents/actions', () => ({
  stopAgentRuntimeAction: vi.fn(),
  syncAgentRuntimeAction: vi.fn(),
  updateAgentAction: vi.fn(async () => ({ savedAt: Date.now() })),
}));

const baseProps = {
  slug: 'acme',
  agentId: 'agent-1',
  name: 'Test agent',
  systemPrompt: '',
  providerId: null,
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
