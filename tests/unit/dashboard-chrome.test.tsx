import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';

const navigation = vi.hoisted(() => ({ pathname: '/app/smoke/agents', search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/workspace/management-actions', () => ({ createWorkspaceAction: vi.fn(), removeWorkspaceMemberAction: vi.fn(), leaveWorkspaceAction: vi.fn(), revokeWorkspaceInvitationAction: vi.fn() }));
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

function chrome(isAdmin = false, initialSidebarCollapsed = false) {
  return (
    <DashboardChrome
      slug="smoke"
      workspaceId="workspace-1"
      workspaceName="Smoke Workspace"
      userLabel="smoke@example.com"
      supportEmail="support@example.com"
      isAdmin={isAdmin}
      initialSidebarCollapsed={initialSidebarCollapsed}
      workspaces={workspaces}
    >
      <div>Workspace content</div>
    </DashboardChrome>
  );
}

function renderChrome(isAdmin = false, initialSidebarCollapsed = false) {
  return render(chrome(isAdmin, initialSidebarCollapsed));
}

describe('DashboardChrome sidebar', () => {
  beforeEach(() => {
    navigation.pathname = '/app/smoke/agents';
    navigation.search = '';
    window.history.replaceState(null, '', navigation.pathname);
    window.localStorage.clear();
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    setDesktopViewport(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([true, false])('renders only feature content in a detached window (desktop=%s)', (desktop) => {
    setDesktopViewport(desktop);
    navigation.search = '__dashboardTab=initial&__dashboardDetached=1';
    const savedTabs = JSON.stringify({
      tabs: [{ id: 'other', href: '/app/smoke/skills', pinned: true }],
      activeTabId: 'other',
    });
    window.sessionStorage.setItem('toolplane:dashboard-tabs:smoke', savedTabs);

    renderChrome();

    expect(screen.getByRole('main')).toHaveTextContent('Workspace content');
    expect(screen.getByRole('main')).toHaveClass('h-dvh', '[--dashboard-tabbar-height:0rem]');
    expect(screen.queryByRole('complementary', { hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Open pages', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open menu', hidden: true })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('toolplane:dashboard-tabs:smoke')).toBe(savedTabs);
  });

  it('keeps feature navigation and reloads detached without discarding query parameters or hashes', () => {
    navigation.search = '__dashboardDetached=1';
    const view = renderChrome();

    navigation.pathname = '/app/smoke/agents/agent-1';
    navigation.search = 'tab=settings';
    window.history.pushState(null, '', `${navigation.pathname}?${navigation.search}#model`);
    view.rerender(chrome());

    expect(window.location.pathname).toBe(navigation.pathname);
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('settings');
    expect(new URLSearchParams(window.location.search).get('__dashboardDetached')).toBe('1');
    expect(window.location.hash).toBe('#model');
    expect(screen.queryByRole('complementary', { hidden: true })).not.toBeInTheDocument();

    view.unmount();
    navigation.search = window.location.search;
    renderChrome();
    expect(screen.getByRole('main')).toHaveTextContent('Workspace content');
    expect(screen.queryByRole('navigation', { name: 'Open pages', hidden: true })).not.toBeInTheDocument();
  });

  it('renders an expanded workspace navigation by default', () => {
    renderChrome();

    const sidebar = screen.getByRole('complementary');
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    expect(sidebar.className).toContain('lg:w-64');
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull();
    expect(screen.queryByText('Discover', { exact: true })).toBeNull();
    expect(screen.getByRole('link', { name: 'Assistants' })).toHaveAttribute('href', '/app/smoke/chat');
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/app/smoke/work');
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/app/smoke/skills');
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/app/smoke/members');
    expect(screen.getByRole('link', { name: 'Model Providers' })).toHaveAttribute('href', '/app/smoke/providers');
    const workspaceButton = screen.getByRole('button', { name: /Smoke Workspace/ });
    const accountButton = screen.getByRole('button', { name: /Personal settings: smoke@example\.com/ });
    expect(workspaceButton.compareDocumentPosition(accountButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the server-seeded collapsed state on the first render', () => {
    renderChrome(false, true);

    expect(screen.getByRole('complementary')).toHaveAttribute('data-collapsed', 'true');
  });

  it('collapses and expands the desktop sidebar', async () => {
    const user = userEvent.setup();
    renderChrome();

    const sidebar = screen.getByRole('complementary');
    const collapseButton = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    expect(collapseButton).toHaveClass('ui-icon-button');
    expect(collapseButton.parentElement).toHaveClass('lg:justify-between');
    await user.click(collapseButton);
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    expect(document.cookie).toContain('toolplane_dashboard_sidebar_workspace-1=true');

    const expandButton = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expandButton).toHaveAttribute('aria-controls', 'dashboard-sidebar');
    expect(expandButton.className).toContain('group');
    await user.click(expandButton);
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  });

  it('restores the collapsed desktop sidebar after a refresh', async () => {
    const user = userEvent.setup();
    const firstRender = renderChrome();

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(window.localStorage.getItem('toolplane:dashboard-sidebar:smoke')).toBe('true');
    firstRender.unmount();

    renderChrome();
    await waitFor(() => expect(screen.getByRole('complementary')).toHaveAttribute('data-collapsed', 'true'));
  });

  it('shows the admin console inside the account menu only for administrators', async () => {
    const user = userEvent.setup();
    renderChrome(true);

    expect(screen.queryByRole('link', { name: 'Admin console' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Personal settings: smoke@example\.com/ }));
    expect(await screen.findByRole('link', { name: 'Admin console' })).toHaveAttribute('href', '/admin');
  });

  it('hides the admin console from member account menus', async () => {
    const user = userEvent.setup();
    renderChrome();

    await user.click(screen.getByRole('button', { name: /Personal settings: smoke@example\.com/ }));
    expect(screen.queryByRole('link', { name: 'Admin console' })).not.toBeInTheDocument();
  });

  it('keeps workspace settings out of the sidebar and opens personal settings from the account menu', async () => {
    const user = userEvent.setup();
    renderChrome();

    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Personal settings: smoke@example\.com/ }));
    expect(screen.getByRole('link', { name: 'Personal settings' })).toHaveAttribute(
      'href',
      '/app/smoke/settings/account?returnTo=%2Fapp%2Fsmoke%2Fagents',
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
