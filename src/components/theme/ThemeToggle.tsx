'use client';

import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { IconButton } from '@toolplane/ui';

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
    <IconButton
      label={label}
      aria-pressed={mounted ? isDark : undefined}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      variant="ghost"
      icon={(
        <span>
        <Sun className="hidden h-4 w-4 dark:block" />
        <Moon className="h-4 w-4 dark:hidden" />
        </span>
      )}
    />
  );
}
