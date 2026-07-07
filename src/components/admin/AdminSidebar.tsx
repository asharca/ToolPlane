'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, Building2, Plug, Brain, Tags, ArrowLeft, type LucideIcon } from 'lucide-react';
import { SITE } from '@/lib/site';

type NavItem = { label: string; href: string; icon: LucideIcon; exact?: boolean };

const ITEMS: NavItem[] = [
  { label: 'Overview', href: '/admin', icon: LayoutDashboard, exact: true },
  { label: 'Users', href: '/admin/users', icon: Users },
  { label: 'Workspaces', href: '/admin/workspaces', icon: Building2 },
  { label: 'ToolPlane', href: '/admin/servers', icon: Plug },
  { label: 'Skills Market', href: '/admin/skills', icon: Brain },
  { label: 'Categories', href: '/admin/categories', icon: Tags },
];

export function AdminSidebar() {
  const t = useTranslations('admin');
  const pathname = usePathname() ?? '';
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 shrink-0 flex-col border-r border-border bg-card lg:sticky lg:top-0 lg:flex lg:h-dvh">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="rounded bg-destructive px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-destructive-foreground">{t('admin1')}</span>
        <span className="text-sm font-semibold text-foreground">{SITE.name}</span>
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
                  ? 'bg-brand-soft font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border p-3">
        <Link href="/app" className="ui-button-ghost w-full justify-start">
          <ArrowLeft className="size-4" /> {t('backToApp')}
        </Link>
      </div>
    </aside>
  );
}
