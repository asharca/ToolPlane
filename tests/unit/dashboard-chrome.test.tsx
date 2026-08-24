import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/smoke/agents',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/workspace/actions', () => ({ createWorkspaceAction: vi.fn() }));
vi.mock('@/lib/auth/actions', () => ({ logoutAction: vi.fn() }));

const workspaces = [
  { id: 'workspace-1', slug: 'smoke', name: 'Smoke Workspace' },
  { id: 'workspace-2', slug: 'staging', name: 'Staging' },
];

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

function renderChrome(isAdmin = false) {
  return render(
    <DashboardChrome
      slug="smoke"
      workspaceName="Smoke Workspace"
      userLabel="smoke@example.com"
      supportEmail="support@example.com"
      isAdmin={isAdmin}
      workspaces={workspaces}
    >
      <main>Workspace content</main>
    </DashboardChrome>,
  );
}

describe('DashboardChrome sidebar', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    setDesktopViewport(true);
  });

  it('renders the fixed compact workspace rail', () => {
    renderChrome();

    const sidebar = screen.getByRole('complementary');
    expect(sidebar.className).toContain('w-16');
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull();
    expect(screen.queryByText('Discover', { exact: true })).toBeNull();
    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/app/smoke/chat');
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/app/smoke/agents');
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/app/smoke/skills');
  });

  it('shows the admin console above the account avatar only for administrators', () => {
    renderChrome(true);

    expect(screen.getByRole('link', { name: 'Admin console' })).toHaveAttribute('href', '/admin');
  });
  it('opens settings as a modal route', () => {
    renderChrome();

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/smoke/settings?returnTo=%2Fapp%2Fsmoke%2Fagents');
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
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
