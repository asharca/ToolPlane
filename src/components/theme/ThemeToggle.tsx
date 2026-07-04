'use client';

import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="ui-button-ghost ui-icon-button"
    >
      <span aria-hidden="true">
        <Sun className="hidden h-4 w-4 dark:block" />
        <Moon className="h-4 w-4 dark:hidden" />
      </span>
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
