'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  Bot,
  Boxes,
  Brain,
  Code2,
  Cpu,
  LayoutDashboard,
  Plug,
  Settings,
  Shield,
  Store,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { SITE } from '@/lib/site';
import { DashboardLogo } from './DashboardLogo';
import { SystemUpdateButton } from './SystemUpdateButton';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

type Workspace = { id: string; slug: string; name: string };

type DashboardTab = {
  labelKey: string;
  segment: string;
  icon: LucideIcon;
};

const TABS: DashboardTab[] = [
  { labelKey: 'overview', segment: 'overview', icon: LayoutDashboard },
  { labelKey: 'market', segment: 'market', icon: Store },
  { labelKey: 'mcpServers', segment: 'mcp', icon: Plug },
  { labelKey: 'skills', segment: 'skills', icon: Brain },
  { labelKey: 'toolkits', segment: 'toolkits', icon: Wrench },
  { labelKey: 'sandboxes', segment: 'sandboxes', icon: Boxes },
  { labelKey: 'modelProviders', segment: 'providers', icon: Cpu },
  { labelKey: 'agents', segment: 'agents', icon: Bot },
  { labelKey: 'observability', segment: 'observability', icon: BarChart3 },
  { labelKey: 'members', segment: 'members', icon: Users },
  { labelKey: 'settings', segment: 'settings', icon: Settings },
];

export function DashboardTabs({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  isAdmin = false,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  isAdmin?: boolean;
}) {
  const pathname = usePathname() ?? '';
  const t = useTranslations('console.sidebar');
  const activeRef = useRef<HTMLAnchorElement>(null);
  const base = `/app/${slug}`;

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
      <div className="flex h-14 items-center justify-between gap-3 px-3 sm:px-4">
        <Link href={`${base}/overview`} aria-label="ToolPlane" className="shrink-0">
          <DashboardLogo />
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          {isAdmin ? <SystemUpdateButton compact /> : null}
          {isAdmin ? (
            <Link
              href="/admin"
              aria-label={t('adminConsole')}
              title={t('adminConsole')}
              className="ui-button-ghost ui-icon-button"
            >
              <Shield className="size-4" />
            </Link>
          ) : null}
          <a
            href={SITE.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('sourceCode')}
            title={t('sourceCode')}
            className="ui-button-ghost ui-icon-button"
          >
            <Code2 className="size-4" />
          </a>
          <WorkspaceSwitcher
            slug={slug}
            workspaceName={workspaceName}
            userLabel={userLabel}
            workspaces={workspaces}
            compact
          />
        </div>
      </div>

      <nav aria-label={t('navigation')} className="flex h-11 max-w-full overflow-x-auto border-t border-border/70 px-2">
        <div className="flex min-w-max items-end gap-1">
          {TABS.map((tab) => {
            const href = `${base}/${tab.segment}`;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            const Icon = tab.icon;
            const label = t(tab.labelKey);

            return (
              <Link
                key={tab.segment}
                ref={active ? activeRef : undefined}
                href={href}
                aria-current={active ? 'page' : undefined}
                title={label}
                className={`-mb-px inline-flex h-10 min-w-14 max-w-40 shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm transition-colors ${
                  active
                    ? 'border-border bg-background font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
