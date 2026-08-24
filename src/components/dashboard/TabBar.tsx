'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

export type Tab = { key: string; label: string; count?: number };

export function TabBar({
  tabs,
  current,
  basePath,
  query,
}: {
  tabs: Tab[];
  current: string;
  basePath: string;
  query?: Record<string, string | undefined>;
}) {
  const activeRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [current]);

  return (
    <div className="max-w-full overflow-x-auto pb-1">
      <div className="inline-flex items-center gap-1 rounded-xl bg-muted p-1 ring-1 ring-border/70">
        {tabs.map((tab) => {
          const active = tab.key === current;
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(query ?? {})) {
            if (value) params.set(key, value);
          }
          if (tab.key !== tabs[0]?.key) params.set('tab', tab.key);
          const href = params.toString() ? `${basePath}?${params}` : basePath;
          return (
            <Link
              key={tab.key}
              ref={active ? activeRef : undefined}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
            >
              {tab.label}
              {typeof tab.count === 'number' ? (
                <span className="text-muted-foreground/70">
                  {tab.count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
