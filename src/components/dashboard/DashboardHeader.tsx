import type { ReactNode } from 'react';
import Link from 'next/link';
import { BreadcrumbItem, Breadcrumbs } from '@toolplane/ui';

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
    <header className="sticky top-0 z-10 bg-background/92 backdrop-blur-xl">
      <div className="flex h-11 items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
        {breadcrumb ? (
          <Breadcrumbs className="text-sm">
            {breadcrumb.map((crumb, i) => {
              const last = i === breadcrumb.length - 1;
              return (
                <BreadcrumbItem
                  key={`${crumb.label}-${i}`}
                  current={last}
                  separator={i > 0 ? '/' : undefined}
                >
                  {crumb.href && !last ? (
                    <Link
                      href={crumb.href}
                      className="truncate font-semibold text-foreground transition-colors hover:text-muted-foreground"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    crumb.label
                  )}
                </BreadcrumbItem>
              );
            })}
          </Breadcrumbs>
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
