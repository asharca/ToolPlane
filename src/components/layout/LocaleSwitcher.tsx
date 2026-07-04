'use client';

import { useLocale } from 'next-intl';
import { setLocale } from '@/lib/i18n/actions';
import type { Locale } from '@/i18n/routing';

export function LocaleSwitcher() {
  const locale = useLocale() as Locale;

  function handleSwitch(next: Locale) {
    if (next !== locale) setLocale(next);
  }

  const buttonClass =
    'inline-flex h-9 min-w-9 items-center justify-center rounded px-2 text-xs font-semibold transition-colors';
  const activeClass = `${buttonClass} bg-brand-soft text-accent-foreground`;
  const inactiveClass =
    `${buttonClass} text-muted-foreground hover:bg-muted hover:text-foreground`;

  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
      <button
        type="button"
        onClick={() => handleSwitch('en')}
        className={locale === 'en' ? activeClass : inactiveClass}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => handleSwitch('zh')}
        className={locale === 'zh' ? activeClass : inactiveClass}
      >
        中
      </button>
    </div>
  );
}
