'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Bot,
  Plug,
  Brain,
  Wrench,
  Boxes,
  BarChart3,
  Users,
  Settings,
  Shield,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  type LucideIcon,
} from 'lucide-react';
import { FaGithub } from 'react-icons/fa';
import { SITE } from '@/lib/site';
import { DashboardLogo } from './DashboardLogo';
import { SystemUpdateButton } from './SystemUpdateButton';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

type NavItem = {
  labelKey: string;
  segment: string;
  icon: LucideIcon;
  badge?: string;
};

type Workspace = { id: string; slug: string; name: string };

const SECTIONS: { titleKey: string; items: NavItem[] }[] = [
  {
    titleKey: 'manage',
    items: [
      { labelKey: 'agents', segment: 'agents', icon: Bot },
      { labelKey: 'mcpServers', segment: 'mcp', icon: Plug },
      { labelKey: 'skills', segment: 'skills', icon: Brain },
      { labelKey: 'toolkits', segment: 'toolkits', icon: Wrench },
      { labelKey: 'sandboxes', segment: 'sandboxes', icon: Boxes },
    ],
  },
  {
    titleKey: 'monitor',
    items: [
      { labelKey: 'observability', segment: 'observability', icon: BarChart3 },
    ],
  },
  {
    titleKey: 'workspace',
    items: [
      { labelKey: 'members', segment: 'members', icon: Users },
      { labelKey: 'settings', segment: 'settings', icon: Settings },
    ],
  },
];

export function DashboardSidebar({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  isAdmin = false,
  mobileOpen = false,
  onClose,
  collapsed = false,
  onToggleCollapsed,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  isAdmin?: boolean;
  mobileOpen?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const pathname = usePathname() ?? '';
  const base = `/app/${slug}`;
  const t = useTranslations('console.sidebar');
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
      id="dashboard-sidebar"
      data-collapsed={collapsed}
      role={mobileOpen ? 'dialog' : undefined}
      aria-modal={mobileOpen ? true : undefined}
      aria-label={mobileOpen ? t('navigation') : undefined}
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-card transition-[transform,width] duration-200 lg:sticky lg:top-0 lg:h-dvh lg:self-start lg:z-auto lg:translate-x-0 lg:bg-card/75 ${
        collapsed ? 'lg:w-16' : 'lg:w-64'
      } ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className={collapsed ? 'px-5 py-5 lg:px-2 lg:py-4' : 'px-5 py-5'}>
        <div className={`flex items-center justify-between gap-2 ${collapsed ? 'lg:justify-center' : ''}`}>
          <Link
            href={base + '/mcp'}
            onClick={onClose}
            aria-label="ToolPlane"
            className={collapsed ? 'lg:hidden' : undefined}
          >
            <DashboardLogo />
          </Link>
          <div className="hidden lg:block">
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
              title={collapsed ? t('expandSidebar') : t('collapseSidebar')}
              className="ui-button-ghost ui-icon-button"
            >
              {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
            </button>
          </div>
          <div className="lg:hidden">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label={t('closeMenu')}
              className="ui-button-ghost ui-icon-button"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>
        {isAdmin ? (
          <div className={collapsed ? 'lg:hidden' : undefined}>
            <SystemUpdateButton />
          </div>
        ) : null}
      </div>

      <nav className={`flex-1 space-y-6 overflow-y-auto py-2 ${collapsed ? 'px-3 lg:px-2' : 'px-3'}`}>
        {SECTIONS.map((section) => (
          <div key={section.titleKey}>
            <p className={`px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground ${collapsed ? 'lg:hidden' : ''}`}>
              {t(section.titleKey)}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const href = `${base}/${item.segment}`;
                const active =
                  pathname === href || pathname.startsWith(href + '/');
                const Icon = item.icon;
                return (
                  <li key={item.segment}>
                    <Link
                      href={href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      aria-label={collapsed ? t(item.labelKey) : undefined}
                      title={collapsed ? t(item.labelKey) : undefined}
                      className={`flex h-11 items-center gap-2.5 rounded-md px-3 text-sm transition-colors lg:h-9 ${
                        collapsed ? 'lg:justify-center lg:px-0' : ''
                      } ${
                        active
                          ? 'bg-brand-soft font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className={`flex-1 ${collapsed ? 'lg:hidden' : ''}`}>{t(item.labelKey)}</span>
                      {item.badge ? (
                        <span className={`rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground ${collapsed ? 'lg:hidden' : ''}`}>
                          {item.badge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t border-border p-3">
        <a
          href={SITE.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          aria-label={t('sourceCode')}
          title={collapsed ? t('sourceCode') : undefined}
          className={`ui-button-secondary w-full ${collapsed ? 'lg:px-0' : ''}`}
        >
          <FaGithub className="size-4" />
          <span className={collapsed ? 'lg:hidden' : undefined}>{t('sourceCode')}</span>
        </a>
        {isAdmin ? (
          <Link
            href="/admin"
            onClick={onClose}
            aria-label={t('adminConsole')}
            title={collapsed ? t('adminConsole') : undefined}
            className={`flex h-9 items-center justify-center gap-2 rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30 ${collapsed ? 'lg:px-0' : ''}`}
          >
            <Shield className="size-4" />
            <span className={collapsed ? 'lg:hidden' : undefined}>{t('adminConsole')}</span>
          </Link>
        ) : null}
        <WorkspaceSwitcher
          slug={slug}
          workspaceName={workspaceName}
          userLabel={userLabel}
          workspaces={workspaces}
          compact={collapsed}
        />
      </div>
    </aside>
  );
}
