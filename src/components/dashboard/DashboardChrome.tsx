'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Menu } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DashboardSidebar } from './DashboardSidebar';
import { DashboardLogo } from './DashboardLogo';
import { DashboardRuntimeConfigProvider } from './DashboardRuntimeConfig';
import { usePersistentBoolean } from '@/lib/use-persistent-boolean';
import { dashboardSidebarCookieName } from '@/lib/sidebar-preferences';
import { hasUnsavedWorkspaceChanges, lastWorkspaceCookieName } from '@/lib/workspace/navigation';
import {
  DASHBOARD_DETACHED_QUERY_PARAM,
  DashboardTabBar,
  DashboardTabContent,
  DashboardTabsProvider,
} from './DashboardTabs';

type Workspace = { id: string; slug: string; name: string };

export function DashboardChrome({
  slug,
  userId,
  workspaceId,
  workspaceName,
  userLabel,
  workspaces,
  supportEmail,
  isAdmin = false,
  initialSidebarCollapsed = false,
  children,
}: {
  slug: string;
  userId?: string;
  workspaceId: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  supportEmail: string;
  isAdmin?: boolean;
  initialSidebarCollapsed?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [detached] = useState(() => searchParams.get(DASHBOARD_DETACHED_QUERY_PARAM) === '1');
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = usePersistentBoolean(
    `toolplane:dashboard-sidebar:${slug}`,
    initialSidebarCollapsed,
    dashboardSidebarCookieName(workspaceId),
  );
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const t = useTranslations('console.sidebar');
  const workspaceT = useTranslations('console.workspaces');

  useEffect(() => {
    if (!detached || searchParams.get(DASHBOARD_DETACHED_QUERY_PARAM) === '1') return;
    // Feature links need not know about the window shell; keep reloads detached too.
    const url = new URL(window.location.href);
    url.searchParams.set(DASHBOARD_DETACHED_QUERY_PARAM, '1');
    window.history.replaceState(null, '', url);
  }, [detached, pathname, searchParams]);

  useEffect(() => {
    const confirm = () => window.confirm(workspaceT('unsavedChanges'));
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, location.href);
      if (target.origin === location.origin && target.pathname.startsWith(`/app/${slug}/`)) return;
      if (hasUnsavedWorkspaceChanges() && !confirm()) { event.preventDefault(); event.stopPropagation(); }
    };
    const submit = (event: SubmitEvent) => {
      if (!(event.target instanceof HTMLFormElement) || !event.target.hasAttribute('data-workspace-navigation')) return;
      if (hasUnsavedWorkspaceChanges(document, event.target) && !confirm()) { event.preventDefault(); event.stopPropagation(); }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedWorkspaceChanges()) { event.preventDefault(); event.returnValue = ''; }
    };
    document.addEventListener('click', click, true);
    document.addEventListener('submit', submit, true);
    window.addEventListener('beforeunload', unload);
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('submit', submit, true);
      window.removeEventListener('beforeunload', unload);
    };
  }, [slug, workspaceT]);

  useEffect(() => {
    if (!userId) return;
    document.cookie = `${lastWorkspaceCookieName(userId)}=${encodeURIComponent(slug)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  }, [slug, userId]);

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

  if (detached) {
    return (
      <DashboardRuntimeConfigProvider supportEmail={supportEmail}>
        <main className="flex h-dvh min-h-0 min-w-0 flex-col overflow-auto overscroll-contain bg-background text-foreground [--dashboard-page-header-height:2.75rem] [--dashboard-tabbar-height:0rem]">
          {children}
        </main>
      </DashboardRuntimeConfigProvider>
    );
  }

  return (
    <DashboardRuntimeConfigProvider supportEmail={supportEmail}>
      <DashboardTabsProvider key={slug} slug={slug}>
        <div className="flex h-dvh min-h-dvh overflow-hidden bg-shell text-foreground [--dashboard-page-header-height:2.75rem] [--dashboard-tabbar-height:2.75rem]">
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
              onToggleCollapsed={() => setCollapsed((value) => !value)}
            />

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-14 shrink-0 items-center gap-3 bg-shell px-3 lg:hidden">
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
              <DashboardTabBar canInstall={isAdmin} />
              <DashboardTabContent>{children}</DashboardTabContent>
            </div>
          </div>
        </DashboardTabsProvider>
    </DashboardRuntimeConfigProvider>
  );
}
