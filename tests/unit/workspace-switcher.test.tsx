import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  it('shows the current workspace and toggles the dropdown', async () => {
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
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Acme/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('menuitem', { name: /Acme/ })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: /Staging/ })).toHaveAttribute(
      'href',
      '/app/staging/mcp',
    );
  });

  it('focuses the first menu item when the current workspace is unavailable', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        slug="missing"
        workspaceName="Unavailable"
        userLabel="me@x.com"
        workspaces={workspaces}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Unavailable/ }));

    expect(screen.getByRole('menuitem', { name: /Acme/ })).toHaveFocus();
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
    await user.click(screen.getByRole('menuitem', { name: /create workspace/i }));
    const input = screen.getByPlaceholderText(/workspace name/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();

    await user.type(input, 'New workspace');
    await user.keyboard('{ArrowLeft}{Home}{End}{ArrowRight}');

    expect(input).toHaveFocus();
    expect(input).toHaveValue('New workspace');
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('navigates menu items with arrow, Home, and End keys', async () => {
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
    const acme = screen.getByRole('menuitem', { name: /Acme/ });
    const staging = screen.getByRole('menuitem', { name: /Staging/ });
    const create = screen.getByRole('menuitem', { name: /create workspace/i });
    const signOut = screen.getByRole('menuitem', { name: /sign out/i });

    expect(acme).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(staging).toHaveFocus();
    await user.keyboard('{End}');
    expect(signOut).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(acme).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(signOut).toHaveFocus();
    await user.keyboard('{Home}{ArrowUp}{ArrowUp}');
    expect(create).toHaveFocus();
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
    await user.keyboard('{ArrowDown}{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape after focus moves outside the menu', async () => {
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
    await user.tab({ shift: true });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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

    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });
});
