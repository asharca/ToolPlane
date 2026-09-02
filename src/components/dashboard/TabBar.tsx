'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Tab as UiTab } from '@toolplane/ui';

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
            <UiTab key={tab.key} asChild navigation current={active}>
              <Link ref={active ? activeRef : undefined} href={href}>
                {tab.label}
                {typeof tab.count === 'number' ? (
                  <span className="text-muted-foreground/70">{tab.count}</span>
                ) : null}
              </Link>
            </UiTab>
          );
        })}
      </div>
    </div>
  );
}
