'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bot,
  Plug,
  Brain,
  Wrench,
  BarChart3,
  Users,
  Settings,
  Store,
  LifeBuoy,
  MessageSquare,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { DashboardLogo } from './DashboardLogo';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

type NavItem = {
  label: string;
  segment: string;
  icon: LucideIcon;
  badge?: string;
};

type Workspace = { id: string; slug: string; name: string };

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Manage',
    items: [
      { label: 'Agents', segment: 'agents', icon: Bot },
      { label: 'MCP Servers', segment: 'mcp', icon: Plug },
      { label: 'Skills', segment: 'skills', icon: Brain },
      { label: 'Toolkits', segment: 'toolkits', icon: Wrench },
    ],
  },
  {
    title: 'Monitor',
    items: [
      { label: 'Observability', segment: 'observability', icon: BarChart3 },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { label: 'Members', segment: 'members', icon: Users },
      { label: 'Settings', segment: 'settings', icon: Settings },
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

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 transition-transform duration-200 lg:sticky lg:top-0 lg:h-dvh lg:self-start lg:z-auto lg:translate-x-0 lg:bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900 lg:dark:bg-zinc-900/60 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="px-5 py-5">
        <Link href={base + '/mcp'} onClick={onClose}>
          <DashboardLogo />
        </Link>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {section.title}
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
                          ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100'
                      }`}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      {item.badge ? (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
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

      <div className="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <Link
          href={`${base}/seller/overview`}
          onClick={onClose}
          className="flex items-center justify-center gap-2 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
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
            href="mailto:support@mcpmarket.com"
            className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <LifeBuoy className="size-3.5" />
            Support
          </a>
          <a
            href="mailto:feedback@mcpmarket.com"
            className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
