'use client';

import {
  CreditCard,
  Cpu,
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
    { label: t('modelProviders'), href: withReturnTo(`${base}/providers`), icon: Cpu },
  ];
  const muted: { label: string; icon: LucideIcon }[] = [
    { label: t('integrations'), icon: Plug },
    { label: t('billing'), icon: CreditCard },
  ];

  return (
    <aside className="shrink-0 bg-shell/70 md:w-52">
      <nav aria-label={t('title')} className="flex gap-1 overflow-x-auto p-3 md:flex-col md:overflow-visible md:p-4">
        {tabs.map(({ label, href, icon: Icon }) => {
          const active = pathname === href.split('?')[0];
          return (
            <Link
              key={label}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
                active
                  ? 'bg-brand-soft font-medium text-foreground ring-1 ring-brand/10'
                  : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
              }`}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
        {muted.map(({ label, icon: Icon }) => (
          <span key={label} aria-disabled="true" className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground/45">
            <Icon className="size-4" />
            {label}
          </span>
        ))}
      </nav>
    </aside>
  );
}
