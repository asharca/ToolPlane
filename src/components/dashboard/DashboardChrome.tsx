'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DashboardSidebar } from './DashboardSidebar';
import { DashboardLogo } from './DashboardLogo';

type Workspace = { id: string; slug: string; name: string };

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
  const t = useTranslations('console.sidebar');

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
