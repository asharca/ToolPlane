'use client';

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
  Store,
  LifeBuoy,
  MessageSquare,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { SITE, mailto } from '@/lib/site';
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

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-card transition-transform duration-200 lg:sticky lg:top-0 lg:h-dvh lg:self-start lg:z-auto lg:translate-x-0 lg:bg-card/75 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="px-5 py-5">
        <Link href={base + '/mcp'} onClick={onClose}>
          <DashboardLogo />
        </Link>
        {isAdmin ? <SystemUpdateButton /> : null}
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
        {SECTIONS.map((section) => (
          <div key={section.titleKey}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-brand-soft font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1">{t(item.labelKey)}</span>
                      {item.badge ? (
                        <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
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
        <Link
          href={`${base}/seller/overview`}
          onClick={onClose}
          className="ui-button-primary w-full"
        >
          <Store className="size-4" />
          Sell Skills
        </Link>
        {isAdmin ? (
          <Link
            href="/admin"
            onClick={onClose}
            className="flex items-center justify-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <Shield className="size-4" />
            Admin console
          </Link>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <a
            href={mailto(SITE.supportEmail)}
            className="ui-button-secondary ui-button-sm"
          >
            <LifeBuoy className="size-3.5" />
            Support
          </a>
          <a
            href={mailto(SITE.feedbackEmail)}
            className="ui-button-secondary ui-button-sm"
          >
            <MessageSquare className="size-3.5" />
            Feedback
          </a>
        </div>
        <WorkspaceSwitcher
          slug={slug}
          workspaceName={workspaceName}
          userLabel={userLabel}
          workspaces={workspaces}
        />
      </div>
    </aside>
  );
}
