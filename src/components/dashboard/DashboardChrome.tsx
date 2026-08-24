'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DashboardSidebar } from './DashboardSidebar';
import { DashboardLogo } from './DashboardLogo';
import { DashboardRuntimeConfigProvider } from './DashboardRuntimeConfig';
import {
  DashboardTabBar,
  DashboardTabContent,
  DashboardTabsProvider,
} from './DashboardTabs';

type Workspace = { id: string; slug: string; name: string };

export function DashboardChrome({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  supportEmail,
  isAdmin = false,
  children,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  supportEmail: string;
  isAdmin?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const t = useTranslations('console.sidebar');

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
              <DashboardTabBar />
              <DashboardTabContent>{children}</DashboardTabContent>
            </div>
          </div>
        </DashboardTabsProvider>
    </DashboardRuntimeConfigProvider>
  );
}
