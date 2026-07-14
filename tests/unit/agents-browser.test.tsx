import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsBrowser } from '@/components/dashboard/agents/AgentsBrowser';

const actions = vi.hoisted(() => ({
  cloneAgentAction: vi.fn(),
  createAgentAction: vi.fn(),
  deleteAgentAction: vi.fn(),
}));

vi.mock('@/lib/agents/actions', () => actions);

describe('AgentsBrowser', () => {
  beforeEach(() => {
    actions.cloneAgentAction.mockReset();
    actions.createAgentAction.mockReset();
    actions.deleteAgentAction.mockReset();
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
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled());
    finishCreate?.();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Created' })).toBeEnabled());
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
            model: 'gpt-4.1',
            toolCount: 2,
            subAgentCount: 1,
            conversationCount: 3,
            runtimeKind: 'native',
            runtimeStatus: null,
          },
        ]}
        createOptions={{ providers: [], deployments: [], skills: [], toolkits: [] }}
      />,
    );

    const cloneButton = screen.getByRole('button', { name: 'Clone agent' });
    const cloneForm = cloneButton.closest('form');
    expect(cloneForm).not.toBeNull();
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="workspace"]')).toHaveValue('acme');
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="agentId"]')).toHaveValue('agent-1');
    expect(cloneForm?.querySelector<HTMLInputElement>('input[name="cloneName"]')).toHaveValue('Researcher copy');

    await user.click(screen.getByRole('button', { name: 'Delete agent' }));
    expect(screen.getByText('Delete this agent and all its conversations?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toHaveFocus();
  });
});
