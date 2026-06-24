import type { ReactNode } from 'react';
import { DashboardHeaderControls } from './DashboardHeaderControls';

export function DashboardHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
      <div className="flex h-16 items-center justify-between gap-4 px-8">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          {title}
        </h1>
        <div className="flex items-center gap-2">
          <DashboardHeaderControls />
          {actions}
        </div>
      </div>
    </header>
  );
}
