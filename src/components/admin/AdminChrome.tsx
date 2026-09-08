'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, Menu, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { AdminSidebar, getAdminPageLabelKey } from './AdminSidebar';

export function AdminChrome({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname() ?? '/admin';
  const t = useTranslations('admin');
  const pageLabel = t(getAdminPageLabelKey(pathname));

  const closeMenu = useCallback(() => {
    setMobileOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, mobileOpen]);

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => {
      if (desktopQuery.matches) setMobileOpen(false);
    };

    desktopQuery.addEventListener('change', closeOnDesktop);
    return () => desktopQuery.removeEventListener('change', closeOnDesktop);
  }, []);

  return (
    <div className="flex h-dvh min-h-dvh overflow-hidden bg-background text-foreground">
      {mobileOpen ? (
        <button
          type="button"
          aria-label={t('adminCloseMenu')}
          onClick={closeMenu}
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
        />
      ) : null}

      <AdminSidebar mobileOpen={mobileOpen} onClose={closeMenu} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="shrink-0 lg:hidden">
              <button
                ref={menuButtonRef}
                type="button"
                aria-label={t('adminOpenMenu')}
                aria-expanded={mobileOpen}
                aria-controls="admin-sidebar"
                onClick={() => setMobileOpen(true)}
                className="ui-button-ghost ui-icon-button"
              >
                <Menu className="size-5" aria-hidden="true" />
              </button>
            </div>
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <Link href="/admin" className="hidden shrink-0 items-center gap-2 text-muted-foreground hover:text-foreground sm:inline-flex">
                <ShieldCheck className="size-4" aria-hidden="true" />
                {t('adminConsoleTitle')}
              </Link>
              <ChevronRight aria-hidden="true" className="hidden size-3.5 shrink-0 text-muted-foreground sm:inline" />
              <span className="truncate font-semibold text-foreground">
                {pageLabel}
              </span>
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <div id="admin-content" inert={mobileOpen} className="min-h-0 flex-1 overflow-auto overscroll-contain">
          {children}
        </div>
      </div>
    </div>
  );
}
