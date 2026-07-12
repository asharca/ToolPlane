'use client';

import { useLocale, useTranslations } from 'next-intl';
import { setLocale } from '@/lib/i18n/actions';
import type { Locale } from '@/i18n/routing';

export function LocaleSwitcher() {
  const t = useTranslations('common');
  const locale = useLocale() as Locale;

  function handleSwitch(next: Locale) {
    if (next !== locale) setLocale(next);
  }

  const buttonClass =
    'inline-flex h-11 min-w-11 items-center justify-center rounded px-2 text-xs font-semibold transition-colors sm:h-9 sm:min-w-9';
  const activeClass = `${buttonClass} bg-brand-soft text-accent-foreground`;
  const inactiveClass =
    `${buttonClass} text-muted-foreground hover:bg-muted hover:text-foreground`;

  return (
    <div
      role="group"
      aria-label={t('language')}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card p-0.5"
    >
      <button
        type="button"
        aria-pressed={locale === 'en'}
        onClick={() => handleSwitch('en')}
        className={locale === 'en' ? activeClass : inactiveClass}
      >
        {t('en')}
      </button>
      <button
        type="button"
        aria-pressed={locale === 'zh'}
        onClick={() => handleSwitch('zh')}
        className={locale === 'zh' ? activeClass : inactiveClass}
      >
        {t('zh')}
      </button>
    </div>
  );
}
