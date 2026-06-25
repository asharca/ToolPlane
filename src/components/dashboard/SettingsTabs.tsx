'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SettingsTabs({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/app/${slug}/settings`;
  const tabs = [
    { label: 'General', href: base },
    { label: 'API Tokens', href: `${base}/tokens` },
  ];
  const muted = ['Integrations', 'Billing'];

  return (
    <nav className="flex items-center gap-6 border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.label}
            href={t.href}
            className={`-mb-px border-b-2 pb-2.5 text-sm transition-colors ${
              active
                ? 'border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
      {muted.map((label) => (
        <span
          key={label}
          className="cursor-default border-b-2 border-transparent pb-2.5 text-sm text-zinc-300 dark:text-zinc-600"
        >
          {label}
        </span>
      ))}
    </nav>
  );
}
