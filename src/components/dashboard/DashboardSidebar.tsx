'use client';

import { type MouseEvent, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Plug,
  Brain,
  Wrench,
  Boxes,
  Store,
  Settings,
  MessageSquare,
  TerminalSquare,
  LibraryBig,
  Cpu,
  Layers3,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { DashboardLogo } from './DashboardLogo';
import { useDashboardTabs } from './DashboardTabs';

type NavItem = {
  labelKey: string;
  segment: string;
  icon: LucideIcon;
};

type Workspace = { id: string; slug: string; name: string };

const NAV_ITEMS: NavItem[] = [
  { labelKey: 'chat', segment: 'chat', icon: MessageSquare },
  { labelKey: 'work', segment: 'work', icon: TerminalSquare },
  { labelKey: 'knowledge', segment: 'knowledge', icon: LibraryBig },
  { labelKey: 'members', segment: 'members', icon: Users },
  { labelKey: 'market', segment: 'market', icon: Store },
  { labelKey: 'mcpServers', segment: 'mcp', icon: Plug },
  { labelKey: 'skills', segment: 'skills', icon: Brain },
  { labelKey: 'toolkits', segment: 'toolkits', icon: Wrench },
  { labelKey: 'sandboxes', segment: 'sandboxes', icon: Boxes },
  { labelKey: 'modelProviders', segment: 'providers', icon: Cpu },
];

export function DashboardSidebar({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  isAdmin = false,
  mobileOpen = false,
  onClose,
  collapsed,
  onToggleCollapsed,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  isAdmin?: boolean;
  mobileOpen?: boolean;
  onClose?: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const pathname = usePathname() ?? '';
  const base = `/app/${slug}`;
  const t = useTranslations('console.sidebar');
  const { openRoute } = useDashboardTabs();
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  function handleWorkspaceRoute(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    openRoute(href);
    onClose?.();
  }

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const syncInert = () => sidebar.toggleAttribute('inert', !desktopQuery.matches && !mobileOpen);
    syncInert();
    desktopQuery.addEventListener('change', syncInert);
    return () => desktopQuery.removeEventListener('change', syncInert);
  }, [mobileOpen]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!mobileOpen || !sidebar) return;
    closeButtonRef.current?.focus();
    const activeSidebar = sidebar;

    function keepFocusInside(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(activeSidebar.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
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
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col overflow-hidden bg-shell text-shell-foreground shadow-2xl transition-[transform,width] duration-200 ease-out lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:self-start lg:translate-x-0 lg:shadow-none ${
        collapsed ? 'lg:w-16' : 'lg:w-64'
      } ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className={`flex h-14 shrink-0 items-center justify-between px-4 ${
        collapsed ? 'lg:justify-center lg:px-0' : 'lg:justify-between lg:px-3'
      }`}>
        <div className="lg:hidden"><DashboardLogo /></div>
        {collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-controls="dashboard-sidebar"
            aria-expanded={false}
            aria-label={t('expandSidebar')}
            title={t('expandSidebar')}
            className="group relative hidden size-9 items-center justify-center overflow-hidden rounded-xl bg-brand text-brand-foreground shadow-sm outline-none transition-[background-color,color] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-brand/40 lg:flex"
          >
            <span
              aria-hidden="true"
              className="flex transition-[opacity,transform] duration-200 ease-out group-hover:scale-90 group-hover:opacity-0 group-focus-visible:scale-90 group-focus-visible:opacity-0"
            >
              <Layers3 className="size-[18px]" strokeWidth={1.9} />
            </span>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex scale-75 items-center justify-center opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100"
            >
              <PanelLeftOpen className="size-[18px]" />
            </span>
          </button>
        ) : (
          <>
            <div className="hidden h-9 w-36 items-center px-1.5 lg:flex">
              <DashboardLogo />
            </div>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-controls="dashboard-sidebar"
              aria-expanded={true}
              aria-label={t('collapseSidebar')}
              title={t('collapseSidebar')}
              className="ui-button-ghost ui-icon-button hidden lg:flex"
            >
              <PanelLeftClose className="size-[18px]" />
            </button>
          </>
        )}
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

      <nav aria-label={t('navigation')} className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 transition-[padding] duration-200 ease-out ${
        collapsed ? 'lg:px-2' : 'lg:px-3'
      }`}>
        <ul className="space-y-0.5 lg:space-y-1">
          {NAV_ITEMS.map((item) => {
            const href = `${base}/${item.segment}`;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            const Icon = item.icon;
            const label = t(item.labelKey);
            return (
              <li key={item.segment}>
                <Link
                  href={href}
                  onClick={(event) => handleWorkspaceRoute(event, href)}
                  aria-current={active ? 'page' : undefined}
                  aria-label={label}
                  title={collapsed ? label : undefined}
                  className={`relative flex h-11 w-full items-center gap-3 overflow-hidden rounded-xl px-3 text-sm transition-[width,height,border-radius,background-color,color] duration-200 ease-out ${
                    collapsed
                      ? 'lg:mx-auto lg:size-9 lg:justify-center lg:gap-0 lg:rounded-full lg:px-0'
                      : 'lg:h-10 lg:rounded-lg'
                  } ${
                    active
                      ? 'bg-brand-soft font-medium text-foreground ring-1 ring-brand/10'
                      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                  }`}
                >
                  <Icon className="size-[18px] shrink-0" />
                  <span className={`min-w-0 flex-1 truncate transition-[max-width,opacity,transform] duration-150 ease-out ${
                    collapsed ? 'lg:max-w-0 lg:translate-x-1 lg:opacity-0' : 'lg:max-w-48 lg:translate-x-0 lg:opacity-100'
                  }`}>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className={`flex shrink-0 flex-col items-stretch gap-1 px-3 py-3 transition-[padding] duration-200 ease-out ${
        collapsed ? 'lg:items-center lg:px-2' : 'lg:px-3'
      }`}>
        <WorkspaceSwitcher
          slug={slug}
          workspaceName={workspaceName}
          userLabel={userLabel}
          workspaces={workspaces}
          isAdmin={isAdmin}
          compact={collapsed}
        />
        <Link
          href={`${base}/settings?returnTo=${encodeURIComponent(pathname)}`}
          onClick={onClose}
          aria-label={t('settings')}
          title={collapsed ? t('settings') : undefined}
          className={`ui-button-ghost justify-start overflow-hidden px-3 transition-[width,border-radius,background-color,color] duration-200 ease-out ${
            collapsed ? 'lg:w-9 lg:justify-center lg:rounded-full lg:px-0' : ''
          }`}
        >
          <Settings className="size-[18px]" />
          <span className={`whitespace-nowrap transition-[max-width,opacity,transform] duration-150 ease-out ${
            collapsed ? 'lg:max-w-0 lg:translate-x-1 lg:opacity-0' : 'lg:max-w-40 lg:translate-x-0 lg:opacity-100'
          }`}>{t('settings')}</span>
        </Link>
      </div>
    </aside>
  );
}
