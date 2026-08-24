import type { ReactNode } from 'react';
import Link from 'next/link';

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
  if (title && !breadcrumb && !actions) {
    return <h1 className="sr-only">{title}</h1>;
  }

  return (
    <header className="sticky top-0 z-10 border-b border-border/80 bg-background/92 backdrop-blur-xl">
      <div className="flex h-11 items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
        {breadcrumb ? (
          <nav className="flex min-w-0 items-center gap-2 overflow-hidden text-sm">
            {breadcrumb.map((crumb, i) => {
              const last = i === breadcrumb.length - 1;
              return (
                <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-2">
                  {i > 0 ? (
                    <span className="shrink-0 text-muted-foreground/55">/</span>
                  ) : null}
                  {crumb.href && !last ? (
                    <Link
                      href={crumb.href}
                      className="truncate font-semibold text-foreground transition-colors hover:text-muted-foreground"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span
                      className={
                        last
                          ? 'truncate text-muted-foreground'
                          : 'truncate font-semibold text-foreground'
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
          <h1 className="text-[15px] font-semibold text-foreground">
            {title}
          </h1>
        )}
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </header>
  );
}
