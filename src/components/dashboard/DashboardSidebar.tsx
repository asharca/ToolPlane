'use client';

import { type MouseEvent, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Bot,
  Plug,
  Brain,
  Wrench,
  Boxes,
  Store,
  Settings,
  Shield,
  MessageSquare,
  TerminalSquare,
  LibraryBig,
  Layers3,
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
  { labelKey: 'agents', segment: 'agents', icon: Bot },
  { labelKey: 'market', segment: 'market', icon: Store },
  { labelKey: 'mcpServers', segment: 'mcp', icon: Plug },
  { labelKey: 'skills', segment: 'skills', icon: Brain },
  { labelKey: 'toolkits', segment: 'toolkits', icon: Wrench },
  { labelKey: 'sandboxes', segment: 'sandboxes', icon: Boxes },
];

export function DashboardSidebar({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  isAdmin = false,
  mobileOpen = false,
  onClose,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  isAdmin?: boolean;
  mobileOpen?: boolean;
  onClose?: () => void;
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
      role={mobileOpen ? 'dialog' : undefined}
      aria-modal={mobileOpen ? true : undefined}
      aria-label={mobileOpen ? t('navigation') : undefined}
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-shell text-shell-foreground shadow-2xl transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-16 lg:self-start lg:translate-x-0 lg:shadow-none ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4 lg:justify-center lg:px-0">
        <div className="lg:hidden"><DashboardLogo /></div>
        <Link
          href={`${base}/chat`}
          onClick={(event) => handleWorkspaceRoute(event, `${base}/chat`)}
          aria-label="ToolPlane"
          title="ToolPlane"
          className="hidden size-9 items-center justify-center rounded-xl bg-brand text-sm font-bold tracking-tight text-brand-foreground shadow-sm lg:flex"
        >
          <Layers3 className="size-[18px]" strokeWidth={1.9} />
        </Link>
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

      <nav aria-label={t('navigation')} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 lg:px-2">
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
                  title={label}
                  className={`relative flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm transition-colors lg:mx-auto lg:size-9 lg:justify-center lg:gap-0 lg:rounded-full lg:px-0 ${
                    active
                      ? 'bg-brand-soft font-medium text-foreground ring-1 ring-brand/10'
                      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                  }`}
                >
                  <Icon className="size-[18px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate lg:sr-only">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex shrink-0 flex-col items-stretch gap-1 border-t border-border/70 px-3 py-3 lg:items-center lg:px-2">
        {isAdmin ? (
          <Link
            href="/admin"
            onClick={onClose}
            aria-label={t('adminConsole')}
            title={t('adminConsole')}
            className="ui-button-ghost justify-start px-3 text-red-600 hover:text-red-700 lg:w-9 lg:rounded-full lg:px-0 dark:text-red-400 dark:hover:text-red-300"
          >
            <Shield className="size-[18px]" />
            <span className="lg:hidden">{t('adminConsole')}</span>
          </Link>
        ) : null}
        <WorkspaceSwitcher
          slug={slug}
          workspaceName={workspaceName}
          userLabel={userLabel}
          workspaces={workspaces}
          compact
        />
        <Link
          href={`${base}/settings?returnTo=${encodeURIComponent(pathname)}`}
          onClick={onClose}
          aria-label={t('settings')}
          title={t('settings')}
          className="ui-button-ghost justify-start px-3 lg:w-9 lg:rounded-full lg:px-0"
        >
          <Settings className="size-[18px]" />
          <span className="lg:hidden">{t('settings')}</span>
        </Link>
      </div>
    </aside>
  );
}
