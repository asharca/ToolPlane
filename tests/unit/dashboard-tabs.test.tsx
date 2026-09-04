import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DashboardTabBar,
  DashboardTabContent,
  DashboardTabsProvider,
  reorderDashboardTabs,
  useDashboardTabs,
} from '@/components/dashboard/DashboardTabs';

const navigation = vi.hoisted(() => ({
  pathname: '/app/smoke/agents',
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

function RouteOpener() {
  const { openRoute } = useDashboardTabs();

  return (
    <button type="button" onClick={() => openRoute('/app/smoke/skills')}>
      Open skills
    </button>
  );
}

function renderTabs(children?: ReactNode) {
  return render(
    <DashboardTabsProvider slug="smoke">
      <DashboardTabBar />
      {children}
      <DashboardTabContent />
    </DashboardTabsProvider>,
  );
}

function openTabs() {
  const navigationElement = screen.getByRole('navigation', { name: 'Open pages' });
  return Array.from(navigationElement.querySelectorAll<HTMLElement>('[data-tab-id]'));
}

function activeTab() {
  const tab = openTabs().find((item) => item.dataset.active === 'true');
  if (!tab) throw new Error('Expected one active dashboard tab');
  return tab;
}

function tabForLabel(label: string) {
  const tab = openTabs().find((item) => item.textContent?.includes(label));
  if (!tab) throw new Error(`Expected ${label} dashboard tab`);
  return tab;
}

describe('DashboardTabsProvider', () => {
  beforeEach(() => {
    navigation.pathname = '/app/smoke/agents';
    navigation.search = '';
    navigation.push.mockClear();
    navigation.replace.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
    window.sessionStorage.clear();
  });

  it('seeds the current route as the active tab', () => {
    renderTabs();

    expect(activeTab()).toHaveTextContent('Agents');
    expect(activeTab()).toHaveAttribute('data-tab-id', 'initial');
    expect(activeTab().querySelector('button')).toHaveAttribute('aria-current', 'page');
  });

  it('renders route content without a full-page entrance animation', () => {
    renderTabs();

    expect(screen.getByRole('main').className).not.toContain('dashboard-enter');
  });

  it.each([
    ['work', 'Agents'],
    ['knowledge', 'Knowledge'],
  ])('uses the sidebar name for the %s tab', (segment, label) => {
    navigation.pathname = `/app/smoke/${segment}`;

    renderTabs();

    expect(activeTab()).toHaveTextContent(label);
  });

  it('opens model providers as its own tab', () => {
    navigation.pathname = '/app/smoke/providers';
    navigation.search = '';

    renderTabs();

    expect(activeTab()).toHaveTextContent('Model Providers');
  });

  it('keeps the originating tab while agent settings is open', () => {
    navigation.pathname = '/app/smoke/agents/agent-1';
    navigation.search = 'returnTo=%2Fapp%2Fsmoke%2Fchat%3Fagent%3Dagent-1%26c%3Dchat-1%26__dashboardTab%3Dchat-tab';

    renderTabs();

    expect(activeTab()).toHaveTextContent('Assistants');
    expect(activeTab()).toHaveAttribute('data-tab-id', 'chat-tab');
  });

  it('keeps the Agents tab while Agent management is open', () => {
    navigation.pathname = '/app/smoke/agents';
    navigation.search = 'returnTo=%2Fapp%2Fsmoke%2Fwork%3F__dashboardTab%3Dwork-tab';

    renderTabs();

    expect(activeTab()).toHaveTextContent('Agents');
    expect(activeTab()).toHaveAttribute('data-tab-id', 'work-tab');
  });

  it('keeps a pinned route open when sidebar navigation opens another route', async () => {
    const user = userEvent.setup();
    renderTabs(<RouteOpener />);

    await user.click(within(tabForLabel('Agents')).getByRole('button', { name: 'Pin Agents' }));
    expect(within(tabForLabel('Agents')).getByRole('button', { name: 'Unpin Agents' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open skills' }));

    await waitFor(() => expect(activeTab()).toHaveTextContent('Skills'));
    expect(openTabs().some((tab) => tab.textContent?.includes('Agents'))).toBe(true);

    await user.click(within(tabForLabel('Agents')).getByRole('button', { name: 'Unpin Agents' }));
    expect(within(tabForLabel('Agents')).getByRole('button', { name: 'Pin Agents' })).toBeInTheDocument();
  });

  it('navigates a reused tab without creating an iframe', async () => {
    const user = userEvent.setup();
    renderTabs(<RouteOpener />);

    await user.click(screen.getByRole('button', { name: 'Open skills' }));

    await waitFor(() => expect(activeTab()).toHaveTextContent('Skills'));
    expect(document.querySelector('iframe')).toBeNull();
    const destination = navigation.push.mock.calls.at(-1)?.[0];
    expect(new URL(destination, 'https://toolplane.local').pathname).toBe('/app/smoke/skills');
  });

  it('closes the active tab and navigates to its fallback', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('button', { name: 'New tab' }));
    await waitFor(() => expect(activeTab()).toHaveTextContent('Assistants'));

    await user.click(screen.getByRole('button', { name: 'Close Assistants' }));

    const fallbackHref = navigation.replace.mock.calls.at(-1)?.[0];
    expect(new URL(fallbackHref, 'https://toolplane.local').pathname).toBe('/app/smoke/agents');
    expect(new URL(fallbackHref, 'https://toolplane.local').searchParams.get('__dashboardTab')).toBeTruthy();
    await waitFor(() => expect(activeTab()).toHaveTextContent('Agents'));
  });

  it('moves a tab into a new browser window', async () => {
    const user = userEvent.setup();
    const openedWindow = { opener: null } as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(openedWindow);
    renderTabs();

    await user.click(screen.getByRole('button', { name: 'Open Agents in new window' }));

    expect(open).toHaveBeenCalledWith(
      '/app/smoke/agents?__dashboardTab=initial&__dashboardDetached=1',
      '_blank',
      'popup,noopener',
    );
    await waitFor(() => expect(activeTab()).toHaveTextContent('Assistants'));
  });

  it('drops saved overview tabs', () => {
    window.sessionStorage.setItem('toolplane:dashboard-tabs:smoke', JSON.stringify({
      tabs: [
        { id: 'old-overview', href: '/app/smoke/overview', pinned: true },
        { id: 'agents', href: '/app/smoke/agents', pinned: false },
      ],
      activeTabId: 'old-overview',
    }));

    renderTabs();

    expect(openTabs()).toHaveLength(1);
    expect(activeTab()).toHaveTextContent('Agents');
    expect(screen.queryByText('Overview')).not.toBeInTheDocument();
  });
});

describe('reorderDashboardTabs', () => {
  it('reorders only within the pinned or regular tab zone', () => {
    const tabs = [
      { id: 'pinned', href: '/app/smoke/chat', pinned: true },
      { id: 'agents', href: '/app/smoke/agents', pinned: false },
      { id: 'skills', href: '/app/smoke/skills', pinned: false },
    ] as Parameters<typeof reorderDashboardTabs>[0];

    expect(reorderDashboardTabs(tabs, 'skills', 'agents').map((tab) => tab.id)).toEqual([
      'pinned',
      'skills',
      'agents',
    ]);
    expect(reorderDashboardTabs(tabs, 'agents', 'pinned')).toEqual(tabs);
  });
});
