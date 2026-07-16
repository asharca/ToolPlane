'use client';

import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

const subscribe = () => () => {};

export function ThemeToggle() {
  const t = useTranslations('common');
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const isDark = mounted && resolvedTheme === 'dark';
  const label = !mounted
    ? t('toggleTheme')
    : isDark
      ? t('switchToLightTheme')
      : t('switchToDarkTheme');

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={mounted ? isDark : undefined}
      title={label}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="ui-button-ghost ui-icon-button"
    >
      <span aria-hidden="true">
        <Sun className="hidden h-4 w-4 dark:block" />
        <Moon className="h-4 w-4 dark:hidden" />
      </span>
      <span className="sr-only">{label}</span>
    </button>
  );
}
