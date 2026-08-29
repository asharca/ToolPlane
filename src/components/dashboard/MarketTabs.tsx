'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot, Brain, MessageCircle, PackageCheck, Plug, Upload, Wrench } from 'lucide-react';

const TABS = [
  { key: 'mcp', labelKey: 'mcp', icon: Plug },
  { key: 'skills', labelKey: 'skills', icon: Brain },
  { key: 'agents', labelKey: 'agents', icon: Bot },
  { key: 'assistants', labelKey: 'assistants', icon: MessageCircle },
  { key: 'toolkits', labelKey: 'toolkits', icon: Wrench },
] as const;

export function MarketTabs({ slug, updateCount = 0 }: { slug: string; updateCount?: number }) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('console.market');
  const base = `/app/${encodeURIComponent(slug)}/market`;

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <nav aria-label={t('navigation')} className="grid min-w-0 flex-1 grid-cols-5 sm:flex">
        {TABS.map((tab) => {
          const href = `${base}/${tab.key}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.key}
              href={href}
              aria-current={active ? 'page' : undefined}
              title={t(tab.labelKey)}
              className={`inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-md px-2 text-sm transition-colors sm:px-3 ${
                active
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <Icon className="size-4 shrink-0" />
              <span className="sr-only truncate sm:not-sr-only">{t(tab.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      <nav aria-label={t('managementNavigation')} className="flex shrink-0 items-center gap-1">
        <Link
          href={`${base}/installed`}
          aria-current={pathname.startsWith(`${base}/installed`) ? 'page' : undefined}
          title={t('installedResources')}
          className="ui-button-ghost relative size-9 p-0"
        >
          <PackageCheck className="size-4" />
          <span className="sr-only">{t('installedResources')}</span>
          {updateCount > 0 ? (
            <span
              aria-label={t('updatesAvailable', { count: updateCount })}
              className="absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-4 text-black"
            >
              {updateCount}
            </span>
          ) : null}
        </Link>
        <Link
          href={`${base}/publish`}
          aria-current={pathname.startsWith(`${base}/publish`) ? 'page' : undefined}
          title={t('publishManagement')}
          className="ui-button-ghost size-9 p-0"
        >
          <Upload className="size-4" />
          <span className="sr-only">{t('publishManagement')}</span>
        </Link>
      </nav>
    </div>
  );
}
