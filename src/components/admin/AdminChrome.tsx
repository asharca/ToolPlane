'use client';

import type { ReactNode } from 'react';
import { ChevronRight, Menu, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { AdminSidebar, getAdminPageLabelKey } from './AdminSidebar';
import { AnimatedSidebarProvider, AnimatedSidebarTrigger } from '@/components/motion/animated-sidebar';

export function AdminChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/admin';
  const t = useTranslations('admin');
  const pageLabel = t(getAdminPageLabelKey(pathname));

  return (
    <AnimatedSidebarProvider className="h-dvh overflow-hidden">
      <AdminSidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <AnimatedSidebarTrigger aria-label={t('adminOpenMenu')}>
              <Menu className="size-5" aria-hidden="true" />
            </AnimatedSidebarTrigger>
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <Link href="/admin" className="hidden shrink-0 items-center gap-2 text-muted-foreground hover:text-foreground sm:inline-flex">
                <ShieldCheck className="size-4" aria-hidden="true" />
                {t('adminConsoleTitle')}
              </Link>
              <ChevronRight aria-hidden="true" className="hidden size-3.5 shrink-0 text-muted-foreground sm:inline" />
              <span className="truncate font-semibold">{pageLabel}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <div id="admin-content" className="min-h-0 flex-1 overflow-auto overscroll-contain">
          {children}
        </div>
      </div>
    </AnimatedSidebarProvider>
  );
}
