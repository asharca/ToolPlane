'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, Building2, Plug, Brain, Tags, ArrowLeft, type LucideIcon } from 'lucide-react';

type NavItem = { label: string; href: string; icon: LucideIcon; exact?: boolean };

const ITEMS: NavItem[] = [
  { label: 'Overview', href: '/admin', icon: LayoutDashboard, exact: true },
  { label: 'Users', href: '/admin/users', icon: Users },
  { label: 'Workspaces', href: '/admin/workspaces', icon: Building2 },
  { label: 'MCP Market', href: '/admin/servers', icon: Plug },
  { label: 'Skills Market', href: '/admin/skills', icon: Brain },
  { label: 'Categories', href: '/admin/categories', icon: Tags },
];

export function AdminSidebar() {
  const pathname = usePathname() ?? '';
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 lg:sticky lg:top-0 lg:flex lg:h-dvh dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">Admin</span>
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">MCP Station</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {ITEMS.map((item) => {
          const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                active
                  ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100'
              }`}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <Link href="/app" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
          <ArrowLeft className="size-4" /> Back to app
        </Link>
      </div>
    </aside>
  );
}
