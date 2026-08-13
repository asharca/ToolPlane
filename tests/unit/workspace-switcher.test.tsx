import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/workspace/actions', () => ({
  createWorkspaceAction: vi.fn(),
}));

vi.mock('@/lib/auth/actions', () => ({
  logoutAction: vi.fn(),
}));

import { WorkspaceSwitcher } from '@/components/dashboard/WorkspaceSwitcher';

const workspaces = [
  { id: 'w1', slug: 'acme', name: 'Acme' },
  { id: 'w2', slug: 'staging', name: 'Staging' },
];

describe('WorkspaceSwitcher', () => {
  it('shows the current workspace in a popover', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        slug="acme"
        workspaceName="Acme"
        userLabel="me@x.com"
        workspaces={workspaces}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Acme/ });
    expect(screen.queryByRole('dialog', { name: /workspaces/i })).toBeNull();

    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: /workspaces/i })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('link', { name: /Acme/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /Staging/ })).toHaveAttribute(
      'href',
      '/app/staging/mcp',
    );
  });

  it('reveals an inline create form', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        slug="acme"
        workspaceName="Acme"
        userLabel="me@x.com"
        workspaces={workspaces}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Acme/ }));
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    const input = screen.getByPlaceholderText(/workspace name/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();

    await user.type(input, 'New workspace');
    await user.keyboard('{ArrowLeft}{Home}{End}{ArrowRight}');

    expect(input).toHaveFocus();
    expect(input).toHaveValue('New workspace');
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        slug="acme"
        workspaceName="Acme"
        userLabel="me@x.com"
        workspaces={workspaces}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Acme/ });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /workspaces/i })).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes when an outside control is clicked', async () => {
    const user = userEvent.setup();
    render(
      <>
        <WorkspaceSwitcher
          slug="acme"
          workspaceName="Acme"
          userLabel="me@x.com"
          workspaces={workspaces}
        />
        <button type="button">Outside</button>
      </>,
    );

    await user.click(screen.getByRole('button', { name: /Acme/ }));
    const outside = screen.getByRole('button', { name: 'Outside' });
    await user.click(outside);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /workspaces/i })).toBeNull());
    expect(outside).toHaveFocus();
  });

  it('shows a sign out action in the account menu', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        slug="acme"
        workspaceName="Acme"
        userLabel="me@x.com"
        workspaces={workspaces}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Acme/ }));

    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
