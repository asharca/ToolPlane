'use client';
import { ButtonLink } from '@/components/motion/button';


import { Radio, Settings, type LucideIcon } from 'lucide-react';

import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function SettingsTabs({ slug }: { slug: string }) {
  const pathname = usePathname();
  const returnTo = useSearchParams().get('returnTo');
  const t = useTranslations('console.settings');
  const base = `/app/${slug}/settings`;
  const withReturnTo = (href: string) => returnTo
    ? `${href}?returnTo=${encodeURIComponent(returnTo)}`
    : href;
  const tabs: { label: string; href: string; icon: LucideIcon }[] = [
    { label: t('general'), href: withReturnTo(base), icon: Settings },
    { label: t('channels'), href: withReturnTo(`${base}/channels`), icon: Radio },
  ];

  return (
    <aside className="shrink-0 md:w-52">
      <nav aria-label={t('title')} className="flex gap-1 overflow-x-auto p-3 md:flex-col md:overflow-visible md:p-4">
        {tabs.map(({ label, href, icon: Icon }) => {
          const active = pathname === href.split('?')[0];
          return (
            <ButtonLink key={label} href={href} aria-current={active ? 'page' : undefined} variant={active ? 'secondary' : 'ghost'} className="shrink-0 justify-start">
              <Icon className="size-4" />
              {label}
            </ButtonLink>
          );
        })}
      </nav>
    </aside>
  );
}
