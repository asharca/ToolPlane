'use client';

import { type MouseEvent, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { HoverCard } from 'radix-ui';
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
  Layers3,
  PanelLeftClose,
  PanelLeftOpen,
  GitFork,
  ExternalLink,
  X,
  type LucideIcon,
} from 'lucide-react';
import { SITE } from '@/lib/site';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { DashboardLogo } from './DashboardLogo';
import { SystemUpdateButton } from './SystemUpdateButton';
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
  { labelKey: 'market', segment: 'market', icon: Store },
  { labelKey: 'mcpServers', segment: 'mcp', icon: Plug },
  { labelKey: 'skills', segment: 'skills', icon: Brain },
  { labelKey: 'toolkits', segment: 'toolkits', icon: Wrench },
  { labelKey: 'sandboxes', segment: 'sandboxes', icon: Boxes },
];

const SOURCE_REPOSITORY = SITE.sourceUrl.replace(/^https?:\/\/github\.com\//, '');

export function DashboardSidebar({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  currentVersion,
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
  currentVersion: string;
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
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-shell text-shell-foreground shadow-2xl transition-[transform,width] duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:self-start lg:translate-x-0 lg:shadow-none ${
        collapsed ? 'lg:w-16' : 'lg:w-64'
      } ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className={`flex h-14 shrink-0 items-center justify-between px-4 ${
        collapsed ? 'lg:justify-center lg:px-0' : 'lg:justify-start lg:px-3'
      }`}>
        <div className="lg:hidden"><DashboardLogo /></div>
        <HoverCard.Root openDelay={200} closeDelay={150}>
          <HoverCard.Trigger asChild>
            <Link
              href={`${base}/chat`}
              onClick={(event) => handleWorkspaceRoute(event, `${base}/chat`)}
              aria-label="ToolPlane"
              className={`hidden items-center justify-center rounded-xl lg:flex ${
                collapsed
                  ? 'size-9 bg-brand text-sm font-bold tracking-tight text-brand-foreground shadow-sm'
                  : 'h-9 px-1.5 hover:bg-accent/70'
              }`}
            >
              {collapsed ? <Layers3 className="size-[18px]" strokeWidth={1.9} /> : <DashboardLogo />}
            </Link>
          </HoverCard.Trigger>
          <HoverCard.Portal>
            <HoverCard.Content
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              className="z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=right]:slide-in-from-left-2"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground">
                  <Layers3 className="size-4" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">ToolPlane</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t('version')} {currentVersion}
                  </p>
                </div>
              </div>
              <a
                href={SITE.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground"
              >
                <GitFork className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block">{t('sourceCode')}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{SOURCE_REPOSITORY}</span>
                </span>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
              <SystemUpdateButton canInstall={isAdmin} />
            </HoverCard.Content>
          </HoverCard.Portal>
        </HoverCard.Root>
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

      <nav aria-label={t('navigation')} className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 ${
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
                  className={`relative flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm transition-colors ${
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
                  <span className={`min-w-0 flex-1 truncate ${collapsed ? 'lg:sr-only' : ''}`}>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className={`flex shrink-0 flex-col items-stretch gap-1 px-3 py-3 ${
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
          className={`ui-button-ghost justify-start px-3 ${
            collapsed ? 'lg:w-9 lg:justify-center lg:rounded-full lg:px-0' : ''
          }`}
        >
          <Settings className="size-[18px]" />
          <span className={collapsed ? 'lg:hidden' : ''}>{t('settings')}</span>
        </Link>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-controls="dashboard-sidebar"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          title={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          className="ui-button-ghost ui-icon-button hidden lg:flex"
        >
          {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
        </button>
      </div>
    </aside>
  );
}
