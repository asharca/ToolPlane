import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentsBrowser } from '@/components/dashboard/agents/AgentsBrowser';

const actions = vi.hoisted(() => ({
  createAgentAction: vi.fn(),
}));

vi.mock('@/lib/agents/actions', () => actions);

describe('AgentsBrowser', () => {
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
});
