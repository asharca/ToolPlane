'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DashboardSidebar } from './DashboardSidebar';
import { DashboardLogo } from './DashboardLogo';
import { DashboardRuntimeConfigProvider } from './DashboardRuntimeConfig';
import {
  DASHBOARD_TAB_FRAME_NAME_PREFIX,
  DASHBOARD_FRAME_QUERY_PARAM,
  DashboardTabBar,
  DashboardTabContent,
  DashboardTabsProvider,
  EmbeddedDashboardFrame,
} from './DashboardTabs';

type Workspace = { id: string; slug: string; name: string };

const SIDEBAR_COLLAPSED_KEY = 'toolplane:dashboard-sidebar-collapsed';
const sidebarListeners = new Set<() => void>();
let inMemoryCollapsed = false;

function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return inMemoryCollapsed;
  }
}

function subscribeSidebarCollapsed(listener: () => void): () => void {
  sidebarListeners.add(listener);
  function handleStorage(event: StorageEvent) {
    if (event.key === SIDEBAR_COLLAPSED_KEY) listener();
  }
  window.addEventListener('storage', handleStorage);
  return () => {
    sidebarListeners.delete(listener);
    window.removeEventListener('storage', handleStorage);
  };
}

function writeSidebarCollapsed(next: boolean) {
  inMemoryCollapsed = next;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
  } catch {
    // Keep the in-memory state when storage is unavailable.
  }
  sidebarListeners.forEach((listener) => listener());
}

function embeddedTabId(searchParams: URLSearchParams): string | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const fromQuery = searchParams.get(DASHBOARD_FRAME_QUERY_PARAM);
  if (fromQuery) return fromQuery;
  return window.name.startsWith(DASHBOARD_TAB_FRAME_NAME_PREFIX)
    ? window.name.slice(DASHBOARD_TAB_FRAME_NAME_PREFIX.length)
    : null;
}

function subscribeToEmbeddedTab() {
  return () => undefined;
}

export function DashboardChrome({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  supportEmail,
  isAdmin = false,
  embedded = false,
  children,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  supportEmail: string;
  isAdmin?: boolean;
  embedded?: boolean;
  children: ReactNode;
}) {
  const searchParams = useSearchParams();
  const frameTabId = useSyncExternalStore(
    subscribeToEmbeddedTab,
    () => embeddedTabId(new URLSearchParams(searchParams.toString())),
    () => embedded ? searchParams.get(DASHBOARD_FRAME_QUERY_PARAM) : null,
  );
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    readSidebarCollapsed,
    () => false,
  );
  const t = useTranslations('console.sidebar');

  function toggleCollapsed() {
    writeSidebarCollapsed(!collapsed);
  }

  const closeMenu = useCallback(() => {
    setOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, open]);

  return (
    <DashboardRuntimeConfigProvider supportEmail={supportEmail}>
      {embedded || frameTabId ? (
        <EmbeddedDashboardFrame slug={slug} tabId={frameTabId}>
          {children}
        </EmbeddedDashboardFrame>
      ) : (
        <DashboardTabsProvider key={slug} slug={slug}>
          <div className="flex h-dvh min-h-dvh bg-background text-foreground [--dashboard-page-header-height:4rem] [--dashboard-tabbar-height:2.75rem]">
            {open ? (
              <button
                type="button"
                aria-label={t('closeMenu')}
                onClick={closeMenu}
                className="fixed inset-0 z-30 bg-black/40 lg:hidden"
              />
            ) : null}

            <DashboardSidebar
              slug={slug}
              workspaceName={workspaceName}
              userLabel={userLabel}
              workspaces={workspaces}
              isAdmin={isAdmin}
              mobileOpen={open}
              onClose={closeMenu}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
            />

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur lg:hidden">
                <button
                  ref={menuButtonRef}
                  type="button"
                  aria-label={t('openMenu')}
                  aria-expanded={open}
                  aria-controls="dashboard-sidebar"
                  onClick={() => setOpen(true)}
                  className="ui-button-ghost ui-icon-button"
                >
                  <Menu className="size-5" />
                </button>
                <DashboardLogo />
              </div>
              <DashboardTabBar />
              <DashboardTabContent />
            </div>
          </div>
        </DashboardTabsProvider>
      )}
    </DashboardRuntimeConfigProvider>
  );
}
