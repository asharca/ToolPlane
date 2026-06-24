import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/workspace/actions', () => ({
  createWorkspaceAction: vi.fn(),
}));

import { WorkspaceSwitcher } from '@/components/dashboard/WorkspaceSwitcher';

const workspaces = [
  { id: 'w1', slug: 'acme', name: 'Acme' },
  { id: 'w2', slug: 'staging', name: 'Staging' },
];

describe('WorkspaceSwitcher', () => {
  it('shows the current workspace and toggles the dropdown', async () => {
    render(
      <WorkspaceSwitcher
        slug="acme"
        workspaceName="Acme"
        userLabel="me@x.com"
        workspaces={workspaces}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Acme/ });
    expect(screen.queryByRole('menu')).toBeNull();

    await userEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Staging/ })).toHaveAttribute(
      'href',
      '/app/staging/mcp',
    );
  });

  it('reveals an inline create form', async () => {
    render(
      <WorkspaceSwitcher
        slug="acme"
        workspaceName="Acme"
        userLabel="me@x.com"
        workspaces={workspaces}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Acme/ }));
    await userEvent.click(screen.getByRole('button', { name: /create workspace/i }));
    expect(screen.getByPlaceholderText(/workspace name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });
});
