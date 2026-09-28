'use client';

import { useLocale, useTranslations } from 'next-intl';
import { setLocale } from '@/lib/i18n/actions';
import type { Locale } from '@/i18n/routing';
import { Button } from '@/components/motion/button';

export function LocaleSwitcher() {
  const t = useTranslations('common');
  const locale = useLocale() as Locale;

  function handleSwitch(next: Locale) {
    if (next !== locale) setLocale(next);
  }


  return (
    <div
      role="group"
      aria-label={t('language')}
      className="inline-flex items-center gap-1"
    >
      <Button
        type="button"
        aria-pressed={locale === 'en'}
        onClick={() => handleSwitch('en')}
        variant={locale === 'en' ? 'secondary' : 'ghost'}
        size="sm"
      >
        {t('en')}
      </Button>
      <Button
        type="button"
        aria-pressed={locale === 'zh'}
        onClick={() => handleSwitch('zh')}
        variant={locale === 'zh' ? 'secondary' : 'ghost'}
        size="sm"
      >
        {t('zh')}
      </Button>
    </div>
  );
}
