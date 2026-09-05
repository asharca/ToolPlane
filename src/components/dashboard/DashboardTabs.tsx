'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  Bot,
  Boxes,
  Brain,
  Cpu,
  MessageSquare,
  TerminalSquare,
  LibraryBig,
  Plug,
  Settings,
  Store,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { WorkspaceTabBar } from '@asharca/ui';
import { DashboardHeaderControls } from './DashboardHeaderControls';

export const DASHBOARD_TAB_QUERY_PARAM = '__dashboardTab';
export const DASHBOARD_DETACHED_QUERY_PARAM = '__dashboardDetached';

const TAB_STORAGE_PREFIX = 'toolplane:dashboard-tabs:';
const INITIAL_TAB_ID = 'initial';

type TabDefinition = { segment: string; labelKey: string; icon: LucideIcon };

export type DashboardWorkspaceTab = { id: string; href: string; pinned: boolean };

type DashboardTabState = { tabs: DashboardWorkspaceTab[]; activeTabId: string };

type DashboardTabsContextValue = DashboardTabState & {
  base: string;
  closeTab: (id: string) => void;
  newTab: () => void;
  openInNewWindow: (id: string) => void;
  openRoute: (href: string) => void;
  reorderTabs: (sourceId: string, targetId: string) => void;
  selectTab: (id: string) => void;
  togglePinned: (id: string) => void;
};

const TAB_DEFINITIONS: TabDefinition[] = [
  { segment: 'market', labelKey: 'market', icon: Store },
  { segment: 'mcp', labelKey: 'mcpServers', icon: Plug },
  { segment: 'skills', labelKey: 'skills', icon: Brain },
  { segment: 'toolkits', labelKey: 'toolkits', icon: Wrench },
  { segment: 'sandboxes', labelKey: 'sandboxes', icon: Boxes },
  { segment: 'providers', labelKey: 'modelProviders', icon: Cpu },
  { segment: 'chat', labelKey: 'chat', icon: MessageSquare },
  { segment: 'work', labelKey: 'work', icon: TerminalSquare },
  { segment: 'knowledge', labelKey: 'knowledge', icon: LibraryBig },
  { segment: 'agents', labelKey: 'agents', icon: Bot },
  { segment: 'observability', labelKey: 'observability', icon: BarChart3 },
  { segment: 'members', labelKey: 'members', icon: Users },
  { segment: 'settings', labelKey: 'settings', icon: Settings },
  { segment: 'seller', labelKey: 'sellSkills', icon: Store },
];

const defaultTab = TAB_DEFINITIONS.find((tab) => tab.segment === 'chat')!;
const DashboardTabsContext = createContext<DashboardTabsContextValue | null>(null);
const tabStateListeners = new Map<string, Set<() => void>>();
const tabStateMemory = new Map<string, DashboardTabState>();

function parseUrl(href: string): URL {
  return new URL(href, 'https://toolplane.local');
}

function normalizeHref(href: string): string {
  const url = parseUrl(href);
  url.searchParams.delete(DASHBOARD_TAB_QUERY_PARAM);
  url.searchParams.delete(DASHBOARD_DETACHED_QUERY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

function currentHref(pathname: string, searchParams: URLSearchParams): string {
  return normalizeHref(`${pathname}${searchParams.size ? `?${searchParams}` : ''}`);
}

function hrefForParent(href: string, id: string): string {
  const url = parseUrl(href);
  url.searchParams.set(DASHBOARD_TAB_QUERY_PARAM, id);
  return `${url.pathname}${url.search}${url.hash}`;
}

function hrefForDetachedWindow(href: string, id: string): string {
  const url = parseUrl(href);
  url.searchParams.set(DASHBOARD_TAB_QUERY_PARAM, id);
  url.searchParams.set(DASHBOARD_DETACHED_QUERY_PARAM, '1');
  return `${url.pathname}${url.search}${url.hash}`;
}

function isWorkspaceHref(href: string, base: string): boolean {
  const pathname = parseUrl(href).pathname;
  return pathname === base || pathname.startsWith(`${base}/`);
}

function locationForTabs(pathname: string, searchParams: URLSearchParams, base: string) {
  const settingsPath = pathname === `${base}/settings` || pathname.startsWith(`${base}/settings/`);
  const agentPath = pathname === `${base}/agents` || (
    pathname.startsWith(`${base}/agents/`)
    && !pathname.slice(`${base}/agents/`.length).includes('/')
  );
  const returnTo = settingsPath || agentPath ? searchParams.get('returnTo') : null;
  if (returnTo && isWorkspaceHref(returnTo, base) && !parseUrl(returnTo).pathname.startsWith(`${base}/settings`)) {
    const url = parseUrl(returnTo);
    return {
      href: normalizeHref(returnTo),
      tabId: url.searchParams.get(DASHBOARD_TAB_QUERY_PARAM),
    };
  }
  return {
    href: currentHref(
      settingsPath ? `${base}/chat` : pathname || `${base}/chat`,
      settingsPath ? new URLSearchParams() : searchParams,
    ),
    tabId: searchParams.get(DASHBOARD_TAB_QUERY_PARAM),
  };
}

function definitionForHref(href: string, base: string): TabDefinition {
  const pathname = parseUrl(href).pathname;
  return TAB_DEFINITIONS.find((tab) => (
    pathname === `${base}/${tab.segment}` || pathname.startsWith(`${base}/${tab.segment}/`)
  )) ?? defaultTab;
}

function orderedTabs(tabs: DashboardWorkspaceTab[]): DashboardWorkspaceTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

function createTabId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createTab(href: string, pinned = false, id = createTabId()): DashboardWorkspaceTab {
  return { id, href: normalizeHref(href), pinned };
}

function storedTabState(value: unknown, base: string): DashboardTabState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { tabs?: unknown; activeTabId?: unknown };
  if (!Array.isArray(candidate.tabs)) return null;
  const tabs = candidate.tabs.flatMap((tab): DashboardWorkspaceTab[] => {
    if (!tab || typeof tab !== 'object') return [];
    const item = tab as Partial<DashboardWorkspaceTab>;
    if (
      typeof item.id !== 'string'
      || typeof item.href !== 'string'
      || typeof item.pinned !== 'boolean'
      || !isWorkspaceHref(item.href, base)
      || parseUrl(item.href).pathname === `${base}/overview`
    ) return [];
    return [{ id: item.id, href: normalizeHref(item.href), pinned: item.pinned }];
  });
  if (!tabs.length) return null;
  const activeTabId = typeof candidate.activeTabId === 'string' && tabs.some((tab) => tab.id === candidate.activeTabId)
    ? candidate.activeTabId
    : tabs[0].id;
  return { tabs: orderedTabs(tabs), activeTabId };
}

function stateForLocation(state: DashboardTabState, href: string, requestedTabId?: string | null): DashboardTabState {
  const requestedTab = requestedTabId ? state.tabs.find((tab) => tab.id === requestedTabId && tab.href === href) : undefined;
  if (requestedTab) return { ...state, activeTabId: requestedTab.id };
  const matchingTab = state.tabs.find((tab) => tab.href === href);
  if (matchingTab) return { ...state, activeTabId: matchingTab.id };
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (activeTab && !activeTab.pinned) {
    return { ...state, tabs: state.tabs.map((tab) => tab.id === activeTab.id ? { ...tab, href } : tab) };
  }
  const tab = createTab(href);
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

function subscribeToTabState(storageKey: string, listener: () => void): () => void {
  const listeners = tabStateListeners.get(storageKey) ?? new Set<() => void>();
  listeners.add(listener);
  tabStateListeners.set(storageKey, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) tabStateListeners.delete(storageKey);
  };
}

function readTabState(storageKey: string, base: string, initialState: DashboardTabState, initialHref: string, initialTabId: string | null, detached: boolean): DashboardTabState {
  if (typeof window === 'undefined' || detached) return initialState;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) {
      tabStateMemory.delete(storageKey);
      return initialState;
    }
    const cached = tabStateMemory.get(storageKey);
    if (cached) return cached;
    const saved = storedTabState(JSON.parse(raw), base);
    const state = saved ? stateForLocation(saved, initialHref, initialTabId) : initialState;
    tabStateMemory.set(storageKey, state);
    return state;
  } catch {
    return tabStateMemory.get(storageKey) ?? initialState;
  }
}

function writeTabState(storageKey: string, state: DashboardTabState) {
  tabStateMemory.set(storageKey, state);
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // The current browser session still works when storage is unavailable.
  }
  tabStateListeners.get(storageKey)?.forEach((listener) => listener());
}

export function reorderDashboardTabs(tabs: DashboardWorkspaceTab[], sourceId: string, targetId: string): DashboardWorkspaceTab[] {
  const source = tabs.find((tab) => tab.id === sourceId);
  const target = tabs.find((tab) => tab.id === targetId);
  if (!source || !target || source.id === target.id || source.pinned !== target.pinned) return tabs;
  const zone = tabs.filter((tab) => tab.pinned === source.pinned);
  const nextZone = [...zone];
  const [moved] = nextZone.splice(zone.findIndex((tab) => tab.id === sourceId), 1);
  nextZone.splice(zone.findIndex((tab) => tab.id === targetId), 0, moved);
  return source.pinned
    ? [...nextZone, ...tabs.filter((tab) => !tab.pinned)]
    : [...tabs.filter((tab) => tab.pinned), ...nextZone];
}

export function useDashboardTabs(): DashboardTabsContextValue {
  const context = useContext(DashboardTabsContext);
  if (!context) throw new Error('Dashboard tabs must be used within DashboardTabsProvider.');
  return context;
}

export function DashboardTabsProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();
  const base = `/app/${slug}`;
  const location = useMemo(
    () => locationForTabs(pathname, new URLSearchParams(searchParams.toString()), base),
    [base, pathname, searchParams],
  );
  const locationTabId = location.tabId;
  const locationHref = location.href;
  const storageKey = `${TAB_STORAGE_PREFIX}${slug}`;
  const [initialLocation] = useState(() => ({ href: locationHref, tabId: locationTabId, detached: searchParams.get(DASHBOARD_DETACHED_QUERY_PARAM) === '1' }));
  const [initialState] = useState<DashboardTabState>(() => {
    const tab = createTab(initialLocation.href, false, initialLocation.tabId || INITIAL_TAB_ID);
    return { tabs: [tab], activeTabId: tab.id };
  });
  const state = useSyncExternalStore(
    useCallback((listener) => subscribeToTabState(storageKey, listener), [storageKey]),
    useCallback(() => readTabState(storageKey, base, initialState, initialLocation.href, initialLocation.tabId, initialLocation.detached), [base, initialLocation, initialState, storageKey]),
    () => initialState,
  );
  const stateRef = useRef(state);
  const navigationIntentRef = useRef<{ id: string; href: string } | null>(null);
  const commitState = useCallback((update: DashboardTabState | ((current: DashboardTabState) => DashboardTabState)) => {
    const next = typeof update === 'function' ? update(stateRef.current) : update;
    stateRef.current = next;
    writeTabState(storageKey, next);
    return next;
  }, [storageKey]);

  useEffect(() => { stateRef.current = state; }, [state]);

  const navigate = useCallback((id: string, href: string, replace = false) => {
    const normalizedHref = normalizeHref(href);
    navigationIntentRef.current = { id, href: normalizedHref };
    const destination = hrefForParent(normalizedHref, id);
    if (replace) router.replace(destination); else router.push(destination);
  }, [router]);

  useEffect(() => {
    const intent = navigationIntentRef.current;
    if (intent?.id === locationTabId && intent.href === locationHref) {
      navigationIntentRef.current = null;
      return;
    }
    commitState((current) => stateForLocation(current, locationHref, locationTabId));
  }, [commitState, locationHref, locationTabId]);

  const selectTab = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((item) => item.id === id);
    if (!tab) return;
    commitState((current) => current.activeTabId === id ? current : { ...current, activeTabId: id });
    if (tab.href !== locationHref || locationTabId !== id) navigate(id, tab.href);
  }, [commitState, locationHref, locationTabId, navigate]);

  const openRoute = useCallback((href: string) => {
    const normalizedHref = normalizeHref(href);
    if (!isWorkspaceHref(normalizedHref, base)) return;
    const existing = stateRef.current.tabs.find((tab) => tab.href === normalizedHref);
    if (existing) {
      commitState((current) => ({ ...current, activeTabId: existing.id }));
      navigate(existing.id, existing.href);
      return;
    }
    const active = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeTabId);
    if (active && !active.pinned) {
      commitState((current) => ({ ...current, tabs: current.tabs.map((tab) => tab.id === active.id ? { ...tab, href: normalizedHref } : tab) }));
      navigate(active.id, normalizedHref);
      return;
    }
    const tab = createTab(normalizedHref);
    commitState((current) => ({ tabs: [...current.tabs, tab], activeTabId: tab.id }));
    navigate(tab.id, tab.href);
  }, [base, commitState, navigate]);

  const newTab = useCallback(() => {
    const tab = createTab(`${base}/${defaultTab.segment}`);
    commitState((current) => ({ tabs: [...current.tabs, tab], activeTabId: tab.id }));
    navigate(tab.id, tab.href);
  }, [base, commitState, navigate]);

  const closeTab = useCallback((id: string) => {
    const current = stateRef.current;
    if (current.tabs.length === 1) return;
    const tabs = orderedTabs(current.tabs);
    const index = tabs.findIndex((tab) => tab.id === id);
    const fallback = tabs[index + 1] ?? tabs[index - 1];
    if (!fallback) return;
    const active = current.activeTabId === id;
    commitState((previous) => ({ tabs: previous.tabs.filter((tab) => tab.id !== id), activeTabId: active ? fallback.id : previous.activeTabId }));
    if (active) navigate(fallback.id, fallback.href, true);
  }, [commitState, navigate]);

  const togglePinned = useCallback((id: string) => commitState((current) => ({
    ...current,
    tabs: orderedTabs(current.tabs.map((tab) => tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)),
  })), [commitState]);
  const reorderTabs = useCallback((sourceId: string, targetId: string) => commitState((current) => ({ ...current, tabs: reorderDashboardTabs(current.tabs, sourceId, targetId) })), [commitState]);
  const openInNewWindow = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((item) => item.id === id);
    if (!tab || !window.open(hrefForDetachedWindow(tab.href, tab.id), '_blank', 'popup,noopener')) return;
    if (stateRef.current.tabs.length === 1) {
      const replacement = createTab(`${base}/${defaultTab.segment}`);
      commitState({ tabs: [replacement], activeTabId: replacement.id });
      navigate(replacement.id, replacement.href, true);
    } else {
      closeTab(id);
    }
  }, [base, closeTab, commitState, navigate]);

  const value = useMemo<DashboardTabsContextValue>(() => ({ ...state, base, closeTab, newTab, openInNewWindow, openRoute, reorderTabs, selectTab, togglePinned }), [base, closeTab, newTab, openInNewWindow, openRoute, reorderTabs, selectTab, state, togglePinned]);
  return <DashboardTabsContext.Provider value={value}>{children}</DashboardTabsContext.Provider>;
}

export function DashboardTabBar({ canInstall = false }: { canInstall?: boolean }) {
  const { activeTabId, base, closeTab, newTab, openInNewWindow, reorderTabs, selectTab, tabs, togglePinned } = useDashboardTabs();
  const sidebarT = useTranslations('console.sidebar');
  const tabT = useTranslations('console.tabs');
  const visibleTabs = orderedTabs(tabs);

  return (
    <WorkspaceTabBar
      activeTabId={activeTabId}
      tabs={visibleTabs.map((tab) => {
        const definition = definitionForHref(tab.href, base);
        return { ...tab, icon: definition.icon, label: sidebarT(definition.labelKey) };
      })}
      labels={{
        navigation: tabT('navigation'),
        newTab: tabT('new'),
        pin: (label) => tabT('pin', { label }),
        unpin: (label) => tabT('unpin', { label }),
        openInNewWindow: (label) => tabT('openInNewWindow', { label }),
        close: (label) => tabT('close', { label }),
      }}
      onClose={closeTab}
      onNewTab={newTab}
      onOpenInNewWindow={openInNewWindow}
      onReorder={reorderTabs}
      onSelect={selectTab}
      onTogglePinned={togglePinned}
      actions={<DashboardHeaderControls canInstall={canInstall} />}
    />
  );
}

export function DashboardTabContent({ children }: { children?: ReactNode }) {
  return (
    <main className="m-2 mt-0 flex min-h-0 flex-1 flex-col overflow-auto rounded-[12px] bg-background lg:ml-0">
      {children}
    </main>
  );
}
