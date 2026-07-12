import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/smoke/agents',
}));

vi.mock('@/lib/workspace/actions', () => ({
  createWorkspaceAction: vi.fn(),
}));

vi.mock('@/lib/auth/actions', () => ({
  logoutAction: vi.fn(),
}));

const workspaces = [
  { id: 'workspace-1', slug: 'smoke', name: 'Smoke Workspace' },
  { id: 'workspace-2', slug: 'staging', name: 'Staging' },
];

const storageValues = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return storageValues.size;
  },
  clear() {
    storageValues.clear();
  },
  getItem(key) {
    return storageValues.get(key) ?? null;
  },
  key(index) {
    return Array.from(storageValues.keys())[index] ?? null;
  },
  removeItem(key) {
    storageValues.delete(key);
  },
  setItem(key, value) {
    storageValues.set(key, String(value));
  },
};

function setDesktopViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as MediaQueryList),
  });
}

function renderChrome() {
  return render(
    <DashboardChrome
      slug="smoke"
      workspaceName="Smoke Workspace"
      userLabel="smoke@example.com"
      workspaces={workspaces}
    >
      <main>Workspace content</main>
    </DashboardChrome>,
  );
}

describe('DashboardChrome sidebar', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageMock,
    });
    window.localStorage.clear();
    setDesktopViewport(true);
  });

  it('collapses to an icon rail and persists the desktop preference', async () => {
    renderChrome();

    const sidebar = screen.getByRole('complementary');
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');

    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    expect(sidebar.className).toContain('lg:w-16');
    expect(window.localStorage.getItem('toolplane:dashboard-sidebar-collapsed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('title', 'Agents');
  });

  it('restores a saved collapsed preference and opens the workspace menu beside the rail', async () => {
    window.localStorage.setItem('toolplane:dashboard-sidebar-collapsed', 'true');
    renderChrome();

    const sidebar = screen.getByRole('complementary');
    await waitFor(() => expect(sidebar).toHaveAttribute('data-collapsed', 'true'));

    await userEvent.click(screen.getByRole('button', { name: 'Smoke Workspace · smoke@example.com' }));
    expect(screen.getByRole('menu').className).toContain('lg:left-full');
    expect(screen.getByRole('menuitem', { name: /Staging/ })).toHaveAttribute(
      'href',
      '/app/staging/mcp',
    );
  });

  it('keeps the closed mobile drawer inert and restores focus after Escape', async () => {
    setDesktopViewport(false);
    renderChrome();

    const menuButton = screen.getByRole('button', { name: 'Open menu' });
    const sidebar = document.getElementById('dashboard-sidebar');
    await waitFor(() => expect(sidebar).toHaveAttribute('inert'));

    await userEvent.click(menuButton);

    const dialog = screen.getByRole('dialog', { name: 'Workspace navigation' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    expect(dialog).not.toHaveAttribute('inert');
    expect(within(dialog).getByRole('button', { name: 'Close menu' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');

    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton).toHaveFocus();
    await waitFor(() => expect(sidebar).toHaveAttribute('inert'));
  });
});
