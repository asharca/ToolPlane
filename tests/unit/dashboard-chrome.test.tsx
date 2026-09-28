import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardChrome } from '@/components/dashboard/DashboardChrome';

const navigation = vi.hoisted(() => ({ pathname: '/app/smoke/agents', search: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname, useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => ({ push: navigation.push, replace: navigation.replace }) }));
vi.mock('@/lib/workspace/management-actions', () => ({ createWorkspaceAction: vi.fn(), removeWorkspaceMemberAction: vi.fn(), leaveWorkspaceAction: vi.fn(), revokeWorkspaceInvitationAction: vi.fn() }));
vi.mock('@/lib/auth/actions', () => ({ logoutAction: vi.fn() }));
const workspaces = [{ id: 'workspace-1', slug: 'smoke', name: 'Smoke Workspace' }, { id: 'workspace-2', slug: 'staging', name: 'Staging' }];

function viewport(desktop: boolean) {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockImplementation((query: string) => ({ matches: query.includes('max-width') ? !desktop : !query.includes('reduced-motion') && desktop, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() } as MediaQueryList)) });
}
function chrome(isAdmin = false, initialSidebarCollapsed = false) {
  return <DashboardChrome slug="smoke" workspaceId="workspace-1" workspaceName="Smoke Workspace" userLabel="smoke@example.com" supportEmail="support@example.com" isAdmin={isAdmin} initialSidebarCollapsed={initialSidebarCollapsed} workspaces={workspaces}><div>Workspace content</div></DashboardChrome>;
}

describe('DashboardChrome', () => {
  beforeEach(() => {
    navigation.pathname = '/app/smoke/agents'; navigation.search = ''; navigation.push.mockClear(); navigation.replace.mockClear();
    window.history.replaceState(null, '', navigation.pathname); window.localStorage.clear(); window.sessionStorage.clear(); viewport(true);
  });

  it('keeps a detached window independent of the saved parent tabs', () => {
    navigation.search = '__dashboardTab=initial&__dashboardDetached=1';
    const saved = JSON.stringify({ tabs: [{ id: 'other', href: '/app/smoke/skills', pinned: true }], activeTabId: 'other' });
    window.sessionStorage.setItem('toolplane:dashboard-tabs:smoke', saved);
    render(chrome());
    expect(screen.getByRole('main')).toHaveTextContent('Workspace content');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('toolplane:dashboard-tabs:smoke')).toBe(saved);
  });

  it('preserves detached navigation state, route filters and the location hash', () => {
    navigation.search = '__dashboardDetached=1';
    const view = render(chrome());
    navigation.pathname = '/app/smoke/agents/agent-1'; navigation.search = 'tab=settings';
    window.history.pushState(null, '', `${navigation.pathname}?${navigation.search}#model`);
    view.rerender(chrome());
    expect(window.location.pathname).toBe(navigation.pathname);
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('settings');
    expect(new URLSearchParams(window.location.search).get('__dashboardDetached')).toBe('1');
    expect(window.location.hash).toBe('#model');
  });

  it('keeps sidebar navigation within the current workspace tab', async () => {
    render(chrome());
    await userEvent.click(screen.getByRole('link', { name: 'Skills' }));
    const target = new URL(navigation.push.mock.calls.at(-1)?.[0], 'https://toolplane.local');
    expect(target.pathname).toBe('/app/smoke/skills');
    expect(target.searchParams.get('__dashboardTab')).toBe('initial');
  });

  it('persists sidebar folding and can unfold after a refresh', async () => {
    const first = render(chrome());
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(window.localStorage.getItem('toolplane:dashboard-sidebar:smoke')).toBe('true'));
    expect(document.cookie).toContain('toolplane_dashboard_sidebar_workspace-1=true');
    first.unmount();
    render(chrome());
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(window.localStorage.getItem('toolplane:dashboard-sidebar:smoke')).toBe('false'));
  });

  it.each([true, false])('projects admin navigation only for administrators (admin=%s)', async (isAdmin) => {
    render(chrome(isAdmin));
    await userEvent.click(screen.getByRole('button', { name: '账户菜单' }));
    if (isAdmin) expect(await screen.findByRole('link', { name: 'Admin console' })).toHaveAttribute('href', '/admin');
    else expect(screen.queryByRole('link', { name: 'Admin console' })).not.toBeInTheDocument();
  });

  it('returns mobile navigation focus to its trigger after Escape', async () => {
    viewport(false);
    render(chrome());
    const trigger = screen.getByRole('button', { name: 'Open menu' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'ToolPlane导航' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ToolPlane导航' })).not.toBeInTheDocument());
  });
});
