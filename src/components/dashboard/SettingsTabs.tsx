'use client';

import {
  CreditCard,
  KeyRound,
  Plug,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
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
    { label: t('tokens'), href: withReturnTo(`${base}/tokens`), icon: KeyRound },
  ];
  const muted: { label: string; icon: LucideIcon }[] = [
    { label: t('integrations'), icon: Plug },
    { label: t('billing'), icon: CreditCard },
  ];

  return (
    <aside className="shrink-0 md:w-48">
      <nav aria-label={t('title')} className="flex gap-1 overflow-x-auto border-b border-border pb-2 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:pb-0 md:pr-4">
        {tabs.map(({ label, href, icon: Icon }) => {
          const active = pathname === href.split('?')[0];
          return (
            <Link
              key={label}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm transition-colors ${
                active
                  ? 'bg-brand-soft font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
        {muted.map(({ label, icon: Icon }) => (
          <span key={label} aria-disabled="true" className="flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground/45">
            <Icon className="size-4" />
            {label}
          </span>
        ))}
      </nav>
    </aside>
  );
}
