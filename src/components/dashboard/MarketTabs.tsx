'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot, Brain, Plug, Wrench } from 'lucide-react';

const TABS = [
  { key: 'mcp', labelKey: 'mcp', icon: Plug },
  { key: 'skills', labelKey: 'skills', icon: Brain },
  { key: 'agents', labelKey: 'agents', icon: Bot },
  { key: 'toolkits', labelKey: 'toolkits', icon: Wrench },
] as const;

export function MarketTabs({ slug }: { slug: string }) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('console.market');
  const base = `/app/${encodeURIComponent(slug)}/market`;

  return (
    <nav aria-label={t('navigation')} className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-muted p-1 ring-1 ring-border/60">
      {TABS.map((tab) => {
        const href = `${base}/${tab.key}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
              active
                ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border/60'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            }`}
          >
            <Icon className="size-4" />
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
