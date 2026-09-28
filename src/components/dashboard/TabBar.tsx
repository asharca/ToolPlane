'use client';

import { ButtonLink } from '@/components/motion/button/base';

export type Tab = { key: string; label: string; count?: number };

export function TabBar({ tabs, current, basePath, query }: { tabs: Tab[]; current: string; basePath: string; query?: Record<string, string | undefined> }) {
  return <nav className="flex max-w-full gap-2 overflow-x-auto" aria-label="Sections">
    {tabs.map((tab) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query ?? {})) if (value) params.set(key, value);
      if (tab.key !== tabs[0]?.key) params.set('tab', tab.key);
      const href = params.toString() ? `${basePath}?${params}` : basePath;
      return <ButtonLink key={tab.key} href={href} variant={tab.key === current ? 'secondary' : 'ghost'} size="sm" aria-current={tab.key === current ? 'page' : undefined} className="shrink-0">
        {tab.label}{typeof tab.count === 'number' ? <span className="text-muted-foreground">{tab.count}</span> : null}
      </ButtonLink>;
    })}
  </nav>;
}
