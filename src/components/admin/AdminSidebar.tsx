'use client';

import { useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Brain,
  Building2,
  LayoutDashboard,
  Plug,
  ShieldCheck,
  Tags,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/layout/Logo';

type AdminPageLabelKey =
  | 'adminNavOverview'
  | 'adminNavUsers'
  | 'adminNavWorkspaces'
  | 'adminNavMcpServers'
  | 'adminNavSkills'
  | 'adminNavCategories';

type AdminSectionLabelKey =
  | 'adminNavOperations'
  | 'adminNavAccess'
  | 'adminNavDirectory';

type NavItem = {
  labelKey: AdminPageLabelKey;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};

type NavSection = {
  labelKey: AdminSectionLabelKey;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    labelKey: 'adminNavOperations',
    items: [
      {
        labelKey: 'adminNavOverview',
        href: '/admin',
        icon: LayoutDashboard,
        exact: true,
      },
    ],
  },
  {
    labelKey: 'adminNavAccess',
    items: [
      { labelKey: 'adminNavUsers', href: '/admin/users', icon: Users },
      {
        labelKey: 'adminNavWorkspaces',
        href: '/admin/workspaces',
        icon: Building2,
      },
    ],
  },
  {
    labelKey: 'adminNavDirectory',
    items: [
      {
        labelKey: 'adminNavMcpServers',
        href: '/admin/servers',
        icon: Plug,
      },
      { labelKey: 'adminNavSkills', href: '/admin/skills', icon: Brain },
      {
        labelKey: 'adminNavCategories',
        href: '/admin/categories',
        icon: Tags,
      },
    ],
  },
];

function isNavItemActive(item: NavItem, pathname: string): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function getAdminPageLabelKey(pathname: string): AdminPageLabelKey {
  for (const section of NAV_SECTIONS) {
    const activeItem = section.items.find((item) =>
      isNavItemActive(item, pathname),
    );
    if (activeItem) return activeItem.labelKey;
  }

  return 'adminNavOverview';
}

export function AdminSidebar({
  mobileOpen = false,
  onClose,
}: {
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname() ?? '/admin';
  const t = useTranslations('admin');
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;

    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const syncInert = () => {
      sidebar.toggleAttribute('inert', !desktopQuery.matches && !mobileOpen);
    };

    syncInert();
    desktopQuery.addEventListener('change', syncInert);
    return () => desktopQuery.removeEventListener('change', syncInert);
  }, [mobileOpen]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!mobileOpen || !sidebar) return;
    const activeSidebar: HTMLElement = sidebar;

    closeButtonRef.current?.focus();

    function keepFocusInside(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        activeSidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', keepFocusInside);
    return () => document.removeEventListener('keydown', keepFocusInside);
  }, [mobileOpen]);

  return (
    <aside
      ref={sidebarRef}
      id="admin-sidebar"
      role={mobileOpen ? 'dialog' : undefined}
      aria-modal={mobileOpen ? true : undefined}
      aria-label={mobileOpen ? t('adminNavigation') : undefined}
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-card transition-transform duration-200 motion-reduce:transition-none lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:self-start lg:translate-x-0 lg:bg-card/75 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-3 border-b border-border px-5">
        <Link
          href="/admin"
          onClick={onClose}
          aria-label={t('adminConsoleTitle')}
          className="flex min-w-0 flex-col items-start"
        >
          <Logo wordmarkClass="text-xl" />
          <span className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <ShieldCheck className="size-3 text-brand" aria-hidden="true" />
            {t('adminConsoleTitle')}
          </span>
        </Link>

        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={t('adminCloseMenu')}
          className="ui-button-ghost ui-icon-button shrink-0 lg:hidden"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      <nav
        aria-label={t('adminNavigation')}
        className="flex-1 space-y-6 overflow-y-auto px-3 py-5"
      >
        {NAV_SECTIONS.map((section) => (
          <div key={section.labelKey}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t(section.labelKey)}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isNavItemActive(item, pathname);
                const Icon = item.icon;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={`flex h-11 items-center gap-2.5 rounded-md px-3 text-sm transition-colors lg:h-9 ${
                        active
                          ? 'bg-brand-soft font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span>{t(item.labelKey)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <Link
          href="/app"
          onClick={onClose}
          className="ui-button-ghost w-full justify-start"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('adminBackToConsole')}
        </Link>
      </div>
    </aside>
  );
}
