'use client';

import type { ReactNode } from 'react';
import { DashboardRuntimeConfigProvider } from './DashboardRuntimeConfig';
import { DashboardTabs } from './DashboardTabs';

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
  return (
    <DashboardRuntimeConfigProvider supportEmail={supportEmail}>
      <div className="min-h-dvh bg-background text-foreground [--dashboard-tabs-height:101px]">
        <DashboardTabs
          slug={slug}
          workspaceName={workspaceName}
          userLabel={userLabel}
          workspaces={workspaces}
          isAdmin={isAdmin}
        />
        <div className="min-w-0">{children}</div>
      </div>
    </DashboardRuntimeConfigProvider>
  );
}
