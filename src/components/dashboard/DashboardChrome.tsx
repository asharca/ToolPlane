'use client';

import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DashboardSidebar } from './DashboardSidebar';
import { DashboardLogo } from './DashboardLogo';

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

export function DashboardChrome({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  isAdmin = false,
  children,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  isAdmin?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    readSidebarCollapsed,
    () => false,
  );
  const t = useTranslations('console.sidebar');

  function toggleCollapsed() {
    writeSidebarCollapsed(!collapsed);
  }

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      {open ? (
        <button
          type="button"
          aria-label={t('closeMenu')}
          onClick={() => setOpen(false)}
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
        onClose={() => setOpen(false)}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            aria-label={t('openMenu')}
            onClick={() => setOpen(true)}
            className="ui-button-ghost ui-icon-button"
          >
            <Menu className="size-5" />
          </button>
          <DashboardLogo />
        </div>
        {children}
      </div>
    </div>
  );
}
