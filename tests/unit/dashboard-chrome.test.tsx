import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      currentVersion="0.22.0"
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the fixed compact workspace rail', () => {
    renderChrome();

    const sidebar = screen.getByRole('complementary');
    expect(sidebar.className).toContain('w-16');
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull();
    expect(screen.queryByText('Discover', { exact: true })).toBeNull();
    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/app/smoke/chat');
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/app/smoke/skills');
  });

  it('shows the admin console inside the account menu only for administrators', async () => {
    const user = userEvent.setup();
    renderChrome(true);

    expect(screen.queryByRole('link', { name: 'Admin console' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Smoke Workspace · smoke@example.com' }));
    expect(await screen.findByRole('link', { name: 'Admin console' })).toHaveAttribute('href', '/admin');
  });

  it('hides the admin console from member account menus', async () => {
    const user = userEvent.setup();
    renderChrome();

    await user.click(screen.getByRole('button', { name: 'Smoke Workspace · smoke@example.com' }));
    expect(screen.queryByRole('link', { name: 'Admin console' })).not.toBeInTheDocument();
  });

  it('shows build details on logo hover and only offers an update after a positive check', async () => {
    const updateStatus = (updateAvailable: boolean) => ({
      ok: true,
      json: async () => ({
        enabled: true,
        canUpdate: true,
        runtimeId: 'runtime-1',
        currentVersion: '0.22.0',
        latestVersion: updateAvailable ? '0.23.0' : '0.22.0',
        updateAvailable,
        releaseName: null,
        releaseUrl: null,
        artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
        reason: null,
      }),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(updateStatus(false))
      .mockResolvedValueOnce(updateStatus(true));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderChrome(true);

    await user.hover(screen.getByRole('link', { name: 'ToolPlane' }));

    expect(await screen.findByText('Version 0.22.0')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Source code/ })).toHaveAttribute(
      'href',
      'https://github.com/asharca/ToolPlane',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check update' }));
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check update' }));
    expect(await screen.findByRole('button', { name: 'Update now' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets members check for updates without offering installation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        enabled: true,
        canUpdate: true,
        runtimeId: 'runtime-1',
        currentVersion: '0.22.0',
        latestVersion: '0.23.0',
        updateAvailable: true,
        releaseName: null,
        releaseUrl: null,
        artifactName: 'toolplane-runtime-linux-amd64.tar.gz',
        reason: null,
      }),
    }));
    const user = userEvent.setup();
    renderChrome();

    await user.hover(screen.getByRole('link', { name: 'ToolPlane' }));
    await user.click(await screen.findByRole('button', { name: 'Check update' }));

    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/v1/admin/system/update', { cache: 'no-store' });
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
