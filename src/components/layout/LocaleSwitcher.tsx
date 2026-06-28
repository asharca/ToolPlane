'use client';

import { useLocale } from 'next-intl';
import { setLocale } from '@/lib/i18n/actions';
import type { Locale } from '@/i18n/routing';

export function LocaleSwitcher() {
  const locale = useLocale() as Locale;

  function handleSwitch(next: Locale) {
    if (next !== locale) setLocale(next);
  }

  const activeClass = 'text-foreground font-semibold';
  const inactiveClass =
    'text-muted-foreground transition-colors hover:text-foreground';

  return (
    <div className="flex items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => handleSwitch('en')}
        className={locale === 'en' ? activeClass : inactiveClass}
      >
        EN
      </button>
      <span className="text-muted-foreground">|</span>
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
