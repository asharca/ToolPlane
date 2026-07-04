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
    <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur">
      <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-8">
        {breadcrumb ? (
          <nav className="flex items-center gap-2 text-sm">
            {breadcrumb.map((crumb, i) => {
              const last = i === breadcrumb.length - 1;
              return (
                <span key={`${crumb.label}-${i}`} className="flex items-center gap-2">
                  {i > 0 ? (
                    <span className="text-muted-foreground/55">/</span>
                  ) : null}
                  {crumb.href && !last ? (
                    <Link
                      href={crumb.href}
                      className="font-semibold text-foreground transition-colors hover:text-muted-foreground"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span
                      className={
                        last
                          ? 'text-muted-foreground'
                          : 'font-semibold text-foreground'
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
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
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
