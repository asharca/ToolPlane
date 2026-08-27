'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot, Brain, LayoutGrid, Plug, Wrench } from 'lucide-react';

const TABS = [
  { key: '', labelKey: 'overview', icon: LayoutGrid },
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
    <nav aria-label={t('navigation')} className="grid max-w-full grid-cols-5 border-b border-border sm:flex">
      {TABS.map((tab) => {
        const href = tab.key ? `${base}/${tab.key}` : base;
        const active = tab.key
          ? pathname === href || pathname.startsWith(`${href}/`)
          : pathname === href;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            title={t(tab.labelKey)}
            className={`inline-flex h-11 min-w-0 items-center justify-center gap-2 border-b-2 px-2 text-sm transition-colors sm:px-3 ${
              active
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
            }`}
          >
            <Icon className="size-4 shrink-0" />
            <span className="sr-only sm:not-sr-only">{t(tab.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
