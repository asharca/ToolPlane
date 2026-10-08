'use client';
import { ButtonLink } from '@/components/motion/button';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot, Brain, MessageCircle, PackageCheck, Plug, Puzzle, Upload, Wrench } from 'lucide-react';

const TABS = [
  { key: 'mcp', labelKey: 'mcp', icon: Plug },
  { key: 'skills', labelKey: 'skills', icon: Brain },
  { key: 'agents', labelKey: 'agents', icon: Bot },
  { key: 'assistants', labelKey: 'assistants', icon: MessageCircle },
  { key: 'toolkits', labelKey: 'toolkits', icon: Wrench },
  { key: 'pi-packages', labelKey: 'piPackages', icon: Puzzle },
] as const;

export function MarketTabs({ slug, updateCount = 0 }: { slug: string; updateCount?: number }) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('console.market');
  const base = `/app/${encodeURIComponent(slug)}/market`;

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <nav aria-label={t('navigation')} className="flex min-w-0 flex-1 overflow-x-auto lg:grid lg:grid-cols-6">
        {TABS.map((tab) => {
          const href = `${base}/${tab.key}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          const Icon = tab.icon;
          return (
            <ButtonLink key={tab.key} href={href} aria-current={active ? 'page' : undefined} title={t(tab.labelKey)} variant={active ? 'secondary' : 'ghost'} className="shrink-0 justify-start border-0">
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{t(tab.labelKey)}</span>
            </ButtonLink>
          );
        })}
      </nav>

      <nav aria-label={t('managementNavigation')} className="flex shrink-0 items-center gap-1">
        <ButtonLink href={`${base}/installed`} aria-current={pathname.startsWith(`${base}/installed`) ? 'page' : undefined} title={t('installedResources')} variant="ghost" size="icon" className="relative">
          <PackageCheck className="size-4" />
          <span className="sr-only">{t('installedResources')}</span>
          {updateCount > 0 ? (
            <span
              aria-label={t('updatesAvailable', { count: updateCount })}
              className="absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-(--color-warning) px-1 text-[10px] font-semibold leading-4 text-foreground"
            >
              {updateCount}
            </span>
          ) : null}
        </ButtonLink>
        <ButtonLink href={`${base}/publish`} aria-current={pathname.startsWith(`${base}/publish`) ? 'page' : undefined} title={t('publishManagement')} variant="ghost" size="icon">
          <Upload className="size-4" />
          <span className="sr-only">{t('publishManagement')}</span>
        </ButtonLink>
      </nav>
    </div>
  );
}
