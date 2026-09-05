'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { NavigationTabs, Tab as UiTab } from '@asharca/ui';

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
    <NavigationTabs>
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
    </NavigationTabs>
  );
}
