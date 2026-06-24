import type { ReactNode } from 'react';
import Link from 'next/link';
import { DashboardHeaderControls } from './DashboardHeaderControls';

export type Crumb = { label: string; href?: string };

export function DashboardHeader({
  title,
  breadcrumb,
  actions,
}: {
  title?: string;
  breadcrumb?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
      <div className="flex h-16 items-center justify-between gap-4 px-8">
        {breadcrumb ? (
          <nav className="flex items-center gap-2 text-sm">
            {breadcrumb.map((crumb, i) => {
              const last = i === breadcrumb.length - 1;
              return (
                <span key={`${crumb.label}-${i}`} className="flex items-center gap-2">
                  {i > 0 ? (
                    <span className="text-zinc-300 dark:text-zinc-600">/</span>
                  ) : null}
                  {crumb.href && !last ? (
                    <Link
                      href={crumb.href}
                      className="font-semibold text-zinc-900 transition-colors hover:text-zinc-600 dark:text-zinc-100 dark:hover:text-zinc-300"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span
                      className={
                        last
                          ? 'text-zinc-500 dark:text-zinc-400'
                          : 'font-semibold text-zinc-900 dark:text-zinc-100'
                      }
                    >
                      {crumb.label}
                    </span>
                  )}
                </span>
              );
            })}
          </nav>
        ) : (
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            {title}
          </h1>
        )}
        <div className="flex items-center gap-2">
          <DashboardHeaderControls />
          {actions}
        </div>
      </div>
    </header>
  );
}
