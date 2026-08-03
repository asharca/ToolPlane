'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot, Brain, Plug } from 'lucide-react';

const TABS = [
  { key: 'mcp', labelKey: 'mcp', icon: Plug },
  { key: 'skills', labelKey: 'skills', icon: Brain },
  { key: 'agents', labelKey: 'agents', icon: Bot },
] as const;

export function MarketTabs({ slug }: { slug: string }) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('console.market');
  const base = `/app/${encodeURIComponent(slug)}/market`;

  return (
    <nav aria-label={t('navigation')} className="flex max-w-full items-center gap-6 overflow-x-auto">
      {TABS.map((tab) => {
        const href = `${base}/${tab.key}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 py-3 text-sm transition-colors ${
              active
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
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
