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
import type { DragEvent, ReactNode, Ref } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  Bot,
  Boxes,
  Brain,
  Cpu,
  ExternalLink,
  LayoutDashboard,
  Pin,
  Plug,
  Plus,
  Settings,
  Store,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';

export const DASHBOARD_TAB_QUERY_PARAM = '__dashboardTab';
export const DASHBOARD_FRAME_QUERY_PARAM = '__dashboardFrame';
export const DASHBOARD_DETACHED_QUERY_PARAM = '__dashboardDetached';
export const DASHBOARD_TAB_MESSAGE = 'toolplane:dashboard-tab-navigation';
export const DASHBOARD_TAB_COMMAND = 'toolplane:dashboard-tab-command';

const TAB_STORAGE_PREFIX = 'toolplane:dashboard-tabs:';
export const DASHBOARD_TAB_FRAME_NAME_PREFIX = 'toolplane-dashboard-tab:';
const INITIAL_TAB_ID = 'initial';

type TabDefinition = {
  segment: string;
  labelKey: string;
  icon: LucideIcon;
};

export type DashboardWorkspaceTab = {
  id: string;
  href: string;
  pinned: boolean;
  title?: string;
};

type DashboardTabState = {
  tabs: DashboardWorkspaceTab[];
  activeTabId: string;
};

type DashboardTabsContextValue = DashboardTabState & {
  base: string;
  closeTab: (id: string) => void;
  newTab: () => void;
  openInNewWindow: (id: string) => void;
  openRoute: (href: string) => void;
  reorderTabs: (sourceId: string, targetId: string) => void;
  selectTab: (id: string) => void;
  setFrameRef: (id: string, frame: HTMLIFrameElement | null) => void;
  togglePinned: (id: string) => void;
};

const TAB_DEFINITIONS: TabDefinition[] = [
  { segment: 'overview', labelKey: 'overview', icon: LayoutDashboard },
  { segment: 'market', labelKey: 'market', icon: Store },
  { segment: 'mcp', labelKey: 'mcpServers', icon: Plug },
  { segment: 'skills', labelKey: 'skills', icon: Brain },
  { segment: 'toolkits', labelKey: 'toolkits', icon: Wrench },
  { segment: 'sandboxes', labelKey: 'sandboxes', icon: Boxes },
  { segment: 'providers', labelKey: 'modelProviders', icon: Cpu },
  { segment: 'agents', labelKey: 'agents', icon: Bot },
  { segment: 'observability', labelKey: 'observability', icon: BarChart3 },
  { segment: 'members', labelKey: 'members', icon: Users },
  { segment: 'settings', labelKey: 'settings', icon: Settings },
  { segment: 'seller', labelKey: 'sellSkills', icon: Store },
];

const overviewTab = TAB_DEFINITIONS[0];

const DashboardTabsContext = createContext<DashboardTabsContextValue | null>(null);

function parseUrl(href: string): URL {
  return new URL(href, 'https://toolplane.local');
}

function normalizeHref(href: string): string {
  const url = parseUrl(href);
  url.searchParams.delete(DASHBOARD_TAB_QUERY_PARAM);
  url.searchParams.delete(DASHBOARD_FRAME_QUERY_PARAM);
  url.searchParams.delete(DASHBOARD_DETACHED_QUERY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

function currentHref(pathname: string, searchParams: URLSearchParams): string {
  const params = new URLSearchParams(searchParams);
  params.delete(DASHBOARD_TAB_QUERY_PARAM);
  params.delete(DASHBOARD_FRAME_QUERY_PARAM);
  params.delete(DASHBOARD_DETACHED_QUERY_PARAM);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}`;
}

function hrefForFrame(href: string, id: string): string {
  const url = parseUrl(href);
  url.searchParams.set(DASHBOARD_FRAME_QUERY_PARAM, id);
  return `${url.pathname}${url.search}${url.hash}`;
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

function definitionForHref(href: string, base: string): TabDefinition {
  const pathname = parseUrl(href).pathname;
  return TAB_DEFINITIONS.find((tab) => (
    pathname === `${base}/${tab.segment}` || pathname.startsWith(`${base}/${tab.segment}/`)
  )) ?? overviewTab;
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
    ) {
      return [];
    }
    return [{
      id: item.id,
      href: normalizeHref(item.href),
      pinned: item.pinned,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
    }];
  });

  if (!tabs.length) return null;
  const activeTabId = typeof candidate.activeTabId === 'string' && tabs.some((tab) => tab.id === candidate.activeTabId)
    ? candidate.activeTabId
    : tabs[0].id;
  return { tabs: orderedTabs(tabs), activeTabId };
}

function stateForLocation(
  state: DashboardTabState,
  href: string,
  requestedTabId?: string | null,
): DashboardTabState {
  const requestedTab = requestedTabId
    ? state.tabs.find((tab) => tab.id === requestedTabId && tab.href === href)
    : undefined;
  if (requestedTab) return { ...state, activeTabId: requestedTab.id };

  const matchingTab = state.tabs.find((tab) => tab.href === href);
  if (matchingTab) return { ...state, activeTabId: matchingTab.id };

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (activeTab && !activeTab.pinned) {
    return {
      ...state,
      tabs: state.tabs.map((tab) => (
        tab.id === activeTab.id ? { ...tab, href, title: undefined } : tab
      )),
    };
  }

  const tab = createTab(href);
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

const tabStateListeners = new Map<string, Set<() => void>>();
const tabStateMemory = new Map<string, DashboardTabState>();

function subscribeToTabState(storageKey: string, listener: () => void): () => void {
  const listeners = tabStateListeners.get(storageKey) ?? new Set<() => void>();
  listeners.add(listener);
  tabStateListeners.set(storageKey, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) tabStateListeners.delete(storageKey);
  };
}

function readTabState(
  storageKey: string,
  base: string,
  initialState: DashboardTabState,
  initialHref: string,
  initialTabId: string | null,
  initialDetached: boolean,
): DashboardTabState {
  if (typeof window === 'undefined') return initialState;
  if (initialDetached) return initialState;

  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch {
    return tabStateMemory.get(storageKey) ?? initialState;
  }
  if (!raw) {
    tabStateMemory.delete(storageKey);
    return initialState;
  }

  const cached = tabStateMemory.get(storageKey);
  if (cached) return cached;

  try {
    const saved = storedTabState(JSON.parse(raw), base);
    const state = saved
      ? stateForLocation(saved, initialHref, initialTabId)
      : initialState;
    tabStateMemory.set(storageKey, state);
    return state;
  } catch {
    return initialState;
  }
}

function writeTabState(storageKey: string, state: DashboardTabState) {
  tabStateMemory.set(storageKey, state);
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Keep the current tab session in memory when storage is unavailable.
  }
  tabStateListeners.get(storageKey)?.forEach((listener) => listener());
}

export function reorderDashboardTabs(
  tabs: DashboardWorkspaceTab[],
  sourceId: string,
  targetId: string,
): DashboardWorkspaceTab[] {
  const source = tabs.find((tab) => tab.id === sourceId);
  const target = tabs.find((tab) => tab.id === targetId);
  if (!source || !target || source.id === target.id || source.pinned !== target.pinned) return tabs;

  const zone = tabs.filter((tab) => tab.pinned === source.pinned);
  const sourceIndex = zone.findIndex((tab) => tab.id === sourceId);
  const targetIndex = zone.findIndex((tab) => tab.id === targetId);
  const nextZone = [...zone];
  const [moved] = nextZone.splice(sourceIndex, 1);
  nextZone.splice(targetIndex, 0, moved);

  const pinned = source.pinned ? nextZone : tabs.filter((tab) => tab.pinned);
  const normal = source.pinned ? tabs.filter((tab) => !tab.pinned) : nextZone;
  return [...pinned, ...normal];
}

export function useDashboardTabs(): DashboardTabsContextValue {
  const context = useContext(DashboardTabsContext);
  if (!context) throw new Error('Dashboard tabs must be used within DashboardTabsProvider.');
  return context;
}

export function DashboardTabsProvider({
  slug,
  children,
}: {
  slug: string;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();
  const base = `/app/${slug}`;
  const locationTabId = searchParams.get(DASHBOARD_TAB_QUERY_PARAM);
  const locationHref = useMemo(
    () => currentHref(pathname || `${base}/overview`, new URLSearchParams(searchParams.toString())),
    [base, pathname, searchParams],
  );
  const storageKey = `${TAB_STORAGE_PREFIX}${slug}`;
  const [initialLocation] = useState(() => ({
    href: locationHref,
    tabId: locationTabId,
    detached: searchParams.get(DASHBOARD_DETACHED_QUERY_PARAM) === '1',
  }));
  const [initialState] = useState<DashboardTabState>(() => {
    const tab = createTab(initialLocation.href, false, initialLocation.tabId || INITIAL_TAB_ID);
    return { tabs: [tab], activeTabId: tab.id };
  });
  const state = useSyncExternalStore(
    useCallback(
      (listener) => subscribeToTabState(storageKey, listener),
      [storageKey],
    ),
    useCallback(
      () => readTabState(
        storageKey,
        base,
        initialState,
        initialLocation.href,
        initialLocation.tabId,
        initialLocation.detached,
      ),
      [base, initialLocation.detached, initialLocation.href, initialLocation.tabId, initialState, storageKey],
    ),
    () => initialState,
  );
  const stateRef = useRef(state);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const frameNavigationIntents = useRef(new Map<string, string>());
  const navigationIntentRef = useRef<{ id: string; href: string } | null>(null);

  const commitState = useCallback((update: DashboardTabState | ((current: DashboardTabState) => DashboardTabState)) => {
    const next = typeof update === 'function' ? update(stateRef.current) : update;
    stateRef.current = next;
    writeTabState(storageKey, next);
    return next;
  }, [storageKey]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const navigate = useCallback((id: string, href: string, replace = false) => {
    const normalizedHref = normalizeHref(href);
    navigationIntentRef.current = { id, href: normalizedHref };
    const destination = hrefForParent(normalizedHref, id);
    if (replace) router.replace(destination);
    else router.push(destination);
  }, [router]);

  const navigateFrame = useCallback((id: string, href: string, replace = false) => {
    const normalizedHref = normalizeHref(href);
    frameNavigationIntents.current.set(id, normalizedHref);
    frameRefs.current.get(id)?.contentWindow?.postMessage({
      type: DASHBOARD_TAB_COMMAND,
      tabId: id,
      href: normalizedHref,
      replace,
    }, window.location.origin);
  }, []);

  useEffect(() => {
    const intent = navigationIntentRef.current;
    if (intent) {
      if (intent.id === locationTabId && intent.href === locationHref) {
        navigationIntentRef.current = null;
      }
      return;
    }
    const previous = stateRef.current;
    const next = commitState((current) => stateForLocation(current, locationHref, locationTabId));
    const previousActive = previous.tabs.find((tab) => tab.id === previous.activeTabId);
    const nextActive = next.tabs.find((tab) => tab.id === next.activeTabId);
    if (previousActive && nextActive && previousActive.id === nextActive.id && previousActive.href !== nextActive.href) {
      navigateFrame(nextActive.id, nextActive.href, true);
    }
  }, [commitState, locationHref, locationTabId, navigateFrame]);

  const selectTab = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((item) => item.id === id);
    if (!tab) return;
    commitState((current) => current.activeTabId === id ? current : { ...current, activeTabId: id });
    if (tab.href !== locationHref || locationTabId !== id) navigate(id, tab.href);
  }, [commitState, locationHref, locationTabId, navigate]);

  const openRoute = useCallback((rawHref: string) => {
    const href = normalizeHref(rawHref);
    if (!isWorkspaceHref(href, base)) return;

    const existing = stateRef.current.tabs.find((tab) => (
      tab.id === stateRef.current.activeTabId && tab.href === href
    )) ?? stateRef.current.tabs.find((tab) => tab.href === href);
    if (existing) {
      commitState((current) => ({ ...current, activeTabId: existing.id }));
      if (existing.href !== locationHref || locationTabId !== existing.id) {
        navigate(existing.id, existing.href);
      }
      return;
    }

    const active = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeTabId);
    if (active && !active.pinned) {
      commitState((current) => ({
        ...current,
        tabs: current.tabs.map((tab) => (
          tab.id === active.id ? { ...tab, href, title: undefined } : tab
        )),
      }));
      navigateFrame(active.id, href);
      navigate(active.id, href);
      return;
    }

    const tab = createTab(href);
    commitState((current) => ({
      tabs: [...current.tabs, tab],
      activeTabId: tab.id,
    }));
    navigate(tab.id, href);
  }, [base, commitState, locationHref, locationTabId, navigate, navigateFrame]);

  const newTab = useCallback(() => {
    const tab = createTab(`${base}/${overviewTab.segment}`);
    commitState((current) => ({
      tabs: [...current.tabs, tab],
      activeTabId: tab.id,
    }));
    navigate(tab.id, tab.href);
  }, [base, commitState, navigate]);

  const closeTab = useCallback((id: string) => {
    const current = stateRef.current;
    if (current.tabs.length === 1) return;
    const ordered = orderedTabs(current.tabs);
    const index = ordered.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const fallback = ordered[index + 1] ?? ordered[index - 1];
    if (!fallback) return;
    const isActive = current.activeTabId === id;
    frameNavigationIntents.current.delete(id);

    commitState((previous) => ({
      tabs: previous.tabs.filter((tab) => tab.id !== id),
      activeTabId: isActive ? fallback.id : previous.activeTabId,
    }));
    if (isActive) navigate(fallback.id, fallback.href, true);
  }, [commitState, navigate]);

  const togglePinned = useCallback((id: string) => {
    commitState((current) => ({
      ...current,
      tabs: orderedTabs(current.tabs.map((tab) => (
        tab.id === id ? { ...tab, pinned: !tab.pinned } : tab
      ))),
    }));
  }, [commitState]);

  const reorderTabs = useCallback((sourceId: string, targetId: string) => {
    commitState((current) => ({
      ...current,
      tabs: reorderDashboardTabs(current.tabs, sourceId, targetId),
    }));
  }, [commitState]);

  const openInNewWindow = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((item) => item.id === id);
    if (!tab) return;
    const opened = window.open(hrefForDetachedWindow(tab.href, tab.id), '_blank', 'popup,noopener');
    if (!opened) return;

    if (stateRef.current.tabs.length === 1) {
      const replacement = createTab(`${base}/${overviewTab.segment}`);
      frameNavigationIntents.current.delete(id);
      commitState({ tabs: [replacement], activeTabId: replacement.id });
      navigate(replacement.id, replacement.href, true);
      return;
    }
    closeTab(id);
  }, [base, closeTab, commitState, navigate]);

  const setFrameRef = useCallback((id: string, frame: HTMLIFrameElement | null) => {
    if (frame) {
      frameRefs.current.set(id, frame);
      const intendedHref = frameNavigationIntents.current.get(id);
      if (intendedHref) frame.src = hrefForFrame(intendedHref, id);
    } else {
      frameRefs.current.delete(id);
    }
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
      const message = event.data as {
        type?: unknown;
        tabId?: unknown;
        workspace?: unknown;
        href?: unknown;
        title?: unknown;
      };
      if (
        message.type !== DASHBOARD_TAB_MESSAGE
        || message.workspace !== slug
        || typeof message.tabId !== 'string'
        || typeof message.href !== 'string'
      ) {
        return;
      }

      const frame = frameRefs.current.get(message.tabId);
      if (!frame || frame.contentWindow !== event.source) return;

      const href = normalizeHref(message.href);
      if (!isWorkspaceHref(href, base)) return;
      const intendedHref = frameNavigationIntents.current.get(message.tabId);
      if (intendedHref && intendedHref !== href) {
        frame.src = hrefForFrame(intendedHref, message.tabId);
        return;
      }
      frameNavigationIntents.current.delete(message.tabId);
      const title = typeof message.title === 'string' ? message.title.slice(0, 120) : undefined;
      const active = stateRef.current.activeTabId === message.tabId;
      commitState((current) => ({
        ...current,
        tabs: current.tabs.map((tab) => (
          tab.id === message.tabId ? { ...tab, href, title } : tab
        )),
      }));
      if (active && locationHref !== href) navigate(message.tabId, href, true);
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [base, commitState, locationHref, navigate, slug]);

  const value = useMemo<DashboardTabsContextValue>(() => ({
    ...state,
    base,
    closeTab,
    newTab,
    openInNewWindow,
    openRoute,
    reorderTabs,
    selectTab,
    setFrameRef,
    togglePinned,
  }), [
    base,
    closeTab,
    newTab,
    openInNewWindow,
    openRoute,
    reorderTabs,
    selectTab,
    setFrameRef,
    state,
    togglePinned,
  ]);

  return (
    <DashboardTabsContext.Provider value={value}>
      {children}
    </DashboardTabsContext.Provider>
  );
}

export function DashboardTabBar() {
  const {
    activeTabId,
    base,
    closeTab,
    newTab,
    openInNewWindow,
    reorderTabs,
    selectTab,
    tabs,
    togglePinned,
  } = useDashboardTabs();
  const sidebarT = useTranslations('console.sidebar');
  const tabT = useTranslations('console.tabs');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const visibleTabs = orderedTabs(tabs);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, visibleTabs.length]);

  return (
    <nav
      aria-label={tabT('navigation')}
      className="flex h-11 shrink-0 border-b border-border bg-card/95 px-2 backdrop-blur"
    >
      <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [&::-webkit-scrollbar]:hidden">
        {visibleTabs.map((tab) => {
          const definition = definitionForHref(tab.href, base);
          const label = tab.title || sidebarT(definition.labelKey);
          return (
            <DashboardTabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              label={label}
              Icon={definition.icon}
              canClose={tabs.length > 1}
              draggingId={draggingId}
              onClose={closeTab}
              onDragChange={setDraggingId}
              onNewWindow={openInNewWindow}
              onReorder={reorderTabs}
              onSelect={selectTab}
              onTogglePinned={togglePinned}
              tabT={tabT}
              activeButtonRef={tab.id === activeTabId ? activeRef : undefined}
            />
          );
        })}
      </ol>
      <button
        type="button"
        aria-label={tabT('new')}
        title={tabT('new')}
        onClick={newTab}
        className="ui-button-ghost ui-icon-button my-1 ml-1 shrink-0"
      >
        <Plus className="size-4" />
      </button>
    </nav>
  );
}

function DashboardTabButton({
  tab,
  active,
  label,
  Icon,
  canClose,
  draggingId,
  onClose,
  onDragChange,
  onNewWindow,
  onReorder,
  onSelect,
  onTogglePinned,
  tabT,
  activeButtonRef,
}: {
  tab: DashboardWorkspaceTab;
  active: boolean;
  label: string;
  Icon: LucideIcon;
  canClose: boolean;
  draggingId: string | null;
  onClose: (id: string) => void;
  onDragChange: (id: string | null) => void;
  onNewWindow: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onSelect: (id: string) => void;
  onTogglePinned: (id: string) => void;
  tabT: ReturnType<typeof useTranslations<'console.tabs'>>;
  activeButtonRef?: Ref<HTMLButtonElement>;
}) {
  const dragAllowed = Boolean(draggingId && draggingId !== tab.id);
  const showControls = active || draggingId === tab.id;

  function stop(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  function onDragStart(event: DragEvent<HTMLLIElement>) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tab.id);
    onDragChange(tab.id);
  }

  function onDragOver(event: DragEvent<HTMLLIElement>) {
    if (!dragAllowed) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function onDrop(event: DragEvent<HTMLLIElement>) {
    if (!draggingId || draggingId === tab.id) return;
    event.preventDefault();
    onReorder(draggingId, tab.id);
    onDragChange(null);
  }

  return (
    <li
      data-tab-id={tab.id}
      data-active={active ? 'true' : undefined}
      draggable
      onDragEnd={() => onDragChange(null)}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
      onDrop={onDrop}
      className={`group flex h-[30px] min-w-24 max-w-56 shrink-0 items-center rounded-[10px] transition-colors ${
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      } ${draggingId === tab.id ? 'opacity-50' : ''}`}
    >
      <button
        ref={activeButtonRef}
        type="button"
        aria-current={active ? 'page' : undefined}
        title={label}
        onAuxClick={(event) => {
          if (event.button === 1) onClose(tab.id);
        }}
        onClick={() => onSelect(tab.id)}
        onDoubleClick={() => onClose(tab.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-xs"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      <div className={`mr-1 flex shrink-0 items-center ${showControls ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
        <button
          type="button"
          aria-label={tab.pinned ? tabT('unpin', { label }) : tabT('pin', { label })}
          title={tab.pinned ? tabT('unpin', { label }) : tabT('pin', { label })}
          onClick={(event) => {
            stop(event);
            onTogglePinned(tab.id);
          }}
          className={`flex size-[18px] items-center justify-center rounded-sm hover:bg-foreground/10 ${tab.pinned ? 'text-foreground' : ''}`}
        >
          <Pin className="size-3" />
        </button>
        <button
          type="button"
          aria-label={tabT('openInNewWindow', { label })}
          title={tabT('openInNewWindow', { label })}
          onClick={(event) => {
            stop(event);
            onNewWindow(tab.id);
          }}
          className="flex size-[18px] items-center justify-center rounded-sm hover:bg-foreground/10"
        >
          <ExternalLink className="size-3" />
        </button>
        {canClose ? (
          <button
            type="button"
            aria-label={tabT('close', { label })}
            title={tabT('close', { label })}
            onClick={(event) => {
              stop(event);
              onClose(tab.id);
            }}
            className="flex size-[18px] items-center justify-center rounded-sm hover:bg-foreground/10"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function DashboardTabContent() {
  const { activeTabId, base, setFrameRef, tabs } = useDashboardTabs();
  const sidebarT = useTranslations('console.sidebar');

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {orderedTabs(tabs).map((tab) => {
        const definition = definitionForHref(tab.href, base);
        const label = tab.title || sidebarT(definition.labelKey);
        const active = tab.id === activeTabId;
        return (
          <DashboardTabFrame
            key={tab.id}
            tab={tab}
            label={label}
            active={active}
            setFrameRef={setFrameRef}
          />
        );
      })}
    </div>
  );
}

function DashboardTabFrame({
  tab,
  label,
  active,
  setFrameRef,
}: {
  tab: DashboardWorkspaceTab;
  label: string;
  active: boolean;
  setFrameRef: (id: string, frame: HTMLIFrameElement | null) => void;
}) {
  const [src] = useState(() => hrefForFrame(tab.href, tab.id));
  const frameRef = useCallback((frame: HTMLIFrameElement | null) => {
    setFrameRef(tab.id, frame);
  }, [setFrameRef, tab.id]);

  return (
    <iframe
      ref={frameRef}
      name={`${DASHBOARD_TAB_FRAME_NAME_PREFIX}${tab.id}`}
      src={src}
      title={label}
      aria-hidden={!active}
      className={`h-full min-h-0 w-full border-0 bg-background ${active ? 'block' : 'hidden'}`}
    />
  );
}

export function EmbeddedDashboardFrame({
  slug,
  tabId,
  children,
}: {
  slug: string;
  tabId: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();
  const base = `/app/${slug}`;
  const href = useMemo(
    () => currentHref(pathname || `${base}/overview`, new URLSearchParams(searchParams.toString())),
    [base, pathname, searchParams],
  );

  useEffect(() => {
    if (!tabId) return;
    const frameTitle = document.querySelector('h1')?.textContent?.trim().slice(0, 120);
    window.parent.postMessage({
      type: DASHBOARD_TAB_MESSAGE,
      workspace: slug,
      tabId,
      href,
      ...(frameTitle ? { title: frameTitle } : {}),
    }, window.location.origin);
  }, [href, slug, tabId]);

  useEffect(() => {
    function onParentCommand(event: MessageEvent<unknown>) {
      const embeddedTabId = tabId;
      if (!embeddedTabId) return;
      if (event.origin !== window.location.origin || event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
      const message = event.data as { type?: unknown; tabId?: unknown; href?: unknown; replace?: unknown };
      if (
        message.type !== DASHBOARD_TAB_COMMAND
        || message.tabId !== embeddedTabId
        || typeof message.href !== 'string'
      ) {
        return;
      }
      const destination = normalizeHref(message.href);
      if (!isWorkspaceHref(destination, base)) return;
      const url = parseUrl(destination);
      url.searchParams.set(DASHBOARD_FRAME_QUERY_PARAM, embeddedTabId);
      const hrefForRouter = `${url.pathname}${url.search}${url.hash}`;
      if (message.replace === true) router.replace(hrefForRouter);
      else router.push(hrefForRouter);
    }

    window.addEventListener('message', onParentCommand);
    return () => window.removeEventListener('message', onParentCommand);
  }, [base, router, tabId]);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      const embeddedTabId = tabId;
      if (!embeddedTabId) return;
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
        || !(event.target instanceof Element)
      ) {
        return;
      }
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (
        !anchor
        || anchor.target
        || anchor.hasAttribute('download')
        || anchor.getAttribute('rel')?.includes('external')
      ) {
        return;
      }

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || !isWorkspaceHref(url.pathname, base)) return;

      url.searchParams.set(DASHBOARD_FRAME_QUERY_PARAM, embeddedTabId);
      event.preventDefault();
      event.stopPropagation();
      router.push(`${url.pathname}${url.search}${url.hash}`);
    }

    document.addEventListener('click', onDocumentClick, true);
    return () => document.removeEventListener('click', onDocumentClick, true);
  }, [base, router, tabId]);

  return (
    <div className="min-h-dvh [--dashboard-page-header-height:4rem] [--dashboard-tabbar-height:0px]">
      {children}
    </div>
  );
}
