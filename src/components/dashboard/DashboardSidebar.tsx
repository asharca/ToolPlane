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
  ChevronsUpDown,
  type LucideIcon,
} from 'lucide-react';
import { DashboardLogo } from './DashboardLogo';

type NavItem = {
  label: string;
  segment: string;
  icon: LucideIcon;
  badge?: string;
};

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Manage',
    items: [
      { label: 'Agents', segment: 'agents', icon: Bot, badge: 'Coming soon' },
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
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
}) {
  const pathname = usePathname() ?? '';
  const base = `/app/${slug}`;
  const initials = (workspaceName.match(/\b\w/g) ?? ['W'])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/60">
      <div className="px-5 py-5">
        <Link href={base + '/mcp'}>
          <DashboardLogo />
        </Link>
      </div>

      <nav className="flex-1 space-y-6 px-3 py-2">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
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
                      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-zinc-200/70 font-medium text-zinc-900'
                          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                      }`}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      {item.badge ? (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700">
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

      <div className="space-y-2 border-t border-zinc-200 p-3">
        <Link
          href={`${base}/seller`}
          className="flex items-center justify-center gap-2 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
        >
          <Store className="size-4" />
          Sell Skills
        </Link>
        <div className="grid grid-cols-2 gap-2">
          <a
            href="mailto:support@mcpmarket.com"
            className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <LifeBuoy className="size-3.5" />
            Support
          </a>
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <MessageSquare className="size-3.5" />
            Feedback
          </button>
        </div>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-100"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-xs font-semibold text-white">
            {initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-zinc-900">
              {workspaceName}
            </span>
            <span className="block truncate text-xs text-zinc-500">
              {userLabel}
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-zinc-400" />
        </button>
      </div>
    </aside>
  );
}
