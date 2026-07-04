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
    <nav className="flex items-center gap-6 border-b border-border">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.label}
            href={t.href}
            className={`-mb-px border-b-2 pb-2.5 text-sm transition-colors ${
              active
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
      {muted.map((label) => (
        <span
          key={label}
          className="cursor-default border-b-2 border-transparent pb-2.5 text-sm text-muted-foreground/45"
        >
          {label}
        </span>
      ))}
    </nav>
  );
}
