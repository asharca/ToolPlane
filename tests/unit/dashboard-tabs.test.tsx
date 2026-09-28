import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardTabsProvider, reorderDashboardTabs, useDashboardTabs, type DashboardWorkspaceTab } from '@/components/dashboard/DashboardTabs';

const navigation = vi.hoisted(() => ({ pathname: '/app/smoke/agents', search: '', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ push: navigation.push, replace: navigation.replace }), useSearchParams: () => new URLSearchParams(navigation.search) }));

function WorkspaceTabsConsumer() {
  const state = useDashboardTabs();
  return <>
    <output aria-label="Open routes">{JSON.stringify(state.tabs)}</output>
    <output aria-label="Active route">{state.tabs.find((tab) => tab.id === state.activeTabId)?.href}</output>
    <button onClick={() => state.openRoute('/app/smoke/skills')}>Open skills</button>
    <button onClick={() => state.openRoute('/app/other/skills')}>Open another workspace</button>
    <button onClick={() => state.togglePinned(state.activeTabId)}>Pin current route</button>
    <button onClick={state.newTab}>Open another route</button>
    <button onClick={() => state.closeTab(state.activeTabId)}>Close current route</button>
    <button onClick={() => state.openInNewWindow(state.activeTabId)}>Detach current route</button>
  </>;
}
function renderTabs(children?: ReactNode) {
  return render(<DashboardTabsProvider slug="smoke"><WorkspaceTabsConsumer />{children}</DashboardTabsProvider>);
}
function openRoutes(): DashboardWorkspaceTab[] {
  return JSON.parse(screen.getByLabelText('Open routes').textContent!);
}

describe('DashboardTabsProvider', () => {
  beforeEach(() => {
    navigation.pathname = '/app/smoke/agents'; navigation.search = '';
    navigation.push.mockClear(); navigation.replace.mockClear(); window.sessionStorage.clear();
  });

  it('reuses the current unpinned route but preserves it after pinning', async () => {
    const first = renderTabs();
    await userEvent.click(screen.getByText('Open skills'));
    expect(openRoutes().map((tab) => tab.href)).toEqual(['/app/smoke/skills']);
    first.unmount(); window.sessionStorage.clear();
    renderTabs();
    await userEvent.click(screen.getByText('Pin current route'));
    await userEvent.click(screen.getByText('Open skills'));
    expect(openRoutes().map((tab) => tab.href)).toEqual(['/app/smoke/agents', '/app/smoke/skills']);
    expect(screen.getByLabelText('Active route')).toHaveTextContent('/app/smoke/skills');
  });

  it('rejects navigation outside its workspace', async () => {
    renderTabs();
    await userEvent.click(screen.getByText('Open another workspace'));
    expect(openRoutes().map((tab) => tab.href)).toEqual(['/app/smoke/agents']);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('closes the current route and navigates to a retained fallback', async () => {
    renderTabs();
    await userEvent.click(screen.getByText('Open another route'));
    await userEvent.click(screen.getByText('Close current route'));
    expect(openRoutes().map((tab) => tab.href)).toEqual(['/app/smoke/agents']);
    const target = new URL(navigation.replace.mock.calls.at(-1)?.[0], 'https://toolplane.local');
    expect(target.pathname).toBe('/app/smoke/agents');
    expect(target.searchParams.get('__dashboardTab')).toBe('initial');
  });

  it('preserves the originating work route while a settings page is open', () => {
    navigation.pathname = '/app/smoke/agents/agent-1';
    navigation.search = 'returnTo=%2Fapp%2Fsmoke%2Fwork%3Fagent%3Dagent-1%26c%3Dchat-1%26__dashboardTab%3Dchat-tab';
    renderTabs();
    expect(openRoutes()).toEqual([{ id: 'chat-tab', href: '/app/smoke/work?agent=agent-1&c=chat-1', pinned: false }]);
  });

  it('detaches safely and leaves a usable parent route', async () => {
    const replace = vi.fn();
    const popup = { opener: window, location: { replace } } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValueOnce(popup);
    renderTabs();
    await userEvent.click(screen.getByText('Detach current route'));
    expect(popup.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith('/app/smoke/agents?__dashboardTab=initial&__dashboardDetached=1');
    await waitFor(() => expect(screen.getByLabelText('Active route')).toHaveTextContent('/app/smoke/chat'));
  });

  it('retains the current route if the browser blocks detachment', async () => {
    vi.spyOn(window, 'open').mockReturnValueOnce(null);
    renderTabs();
    await userEvent.click(screen.getByText('Detach current route'));
    expect(openRoutes().map((tab) => tab.href)).toEqual(['/app/smoke/agents']);
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe('reorderDashboardTabs', () => {
  it('reorders only within the pinned or regular zone', () => {
    const tabs: DashboardWorkspaceTab[] = [{ id: 'pinned', href: '/app/smoke/chat', pinned: true }, { id: 'agents', href: '/app/smoke/agents', pinned: false }, { id: 'skills', href: '/app/smoke/skills', pinned: false }];
    expect(reorderDashboardTabs(tabs, 'skills', 'agents').map((tab) => tab.id)).toEqual(['pinned', 'skills', 'agents']);
    expect(reorderDashboardTabs(tabs, 'agents', 'pinned')).toEqual(tabs);
  });
});
