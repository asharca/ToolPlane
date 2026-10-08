'use client';

import { ArrowLeft, Bot, Brain, Building2, ClipboardCheck, LayoutDashboard, Library, MessageSquare, Plug, Settings, ScrollText, Tags, Users, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/layout/Logo';
import { WorkspaceSidebar } from '@/components/workspace/workspace-sidebar';

type AdminPageLabelKey =
  | 'adminNavOverview' | 'adminNavSettings' | 'adminNavLogs' | 'adminNavUsers'
  | 'adminNavWorkspaces' | 'adminNavMcpServers' | 'adminNavSkills' | 'adminNavAgents'
  | 'adminNavAssistants' | 'adminNavMarketReviews' | 'adminNavCatalog' | 'adminNavCategories';

type AdminSectionLabelKey = 'adminNavOperations' | 'adminNavAccess' | 'adminNavDirectory';

type NavItem = { labelKey: AdminPageLabelKey; href: string; icon: LucideIcon; exact?: boolean };
type NavSection = { labelKey: AdminSectionLabelKey; items: NavItem[] };

const NAV_SECTIONS: NavSection[] = [
  { labelKey: 'adminNavOperations', items: [
    { labelKey: 'adminNavOverview', href: '/admin', icon: LayoutDashboard, exact: true },
    { labelKey: 'adminNavLogs', href: '/admin/logs', icon: ScrollText },
    { labelKey: 'adminNavMarketReviews', href: '/admin/reviews', icon: ClipboardCheck },
    { labelKey: 'adminNavSettings', href: '/admin/settings', icon: Settings },
  ] },
  { labelKey: 'adminNavAccess', items: [
    { labelKey: 'adminNavUsers', href: '/admin/users', icon: Users },
    { labelKey: 'adminNavWorkspaces', href: '/admin/workspaces', icon: Building2 },
  ] },
  { labelKey: 'adminNavDirectory', items: [
    { labelKey: 'adminNavCatalog', href: '/admin/market', icon: Library },
    { labelKey: 'adminNavMcpServers', href: '/admin/servers', icon: Plug },
    { labelKey: 'adminNavSkills', href: '/admin/skills', icon: Brain },
    { labelKey: 'adminNavAgents', href: '/admin/agents', icon: Bot },
    { labelKey: 'adminNavAssistants', href: '/admin/assistants', icon: MessageSquare },
    { labelKey: 'adminNavCategories', href: '/admin/categories', icon: Tags },
  ] },
];

function isNavItemActive(item: NavItem, pathname: string): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function getAdminPageLabelKey(pathname: string): AdminPageLabelKey {
  for (const section of NAV_SECTIONS) {
    const activeItem = section.items.find((item) => isNavItemActive(item, pathname));
    if (activeItem) return activeItem.labelKey;
  }
  return 'adminNavOverview';
}

export function AdminSidebar() {
  const pathname = usePathname() ?? '/admin';
  const t = useTranslations('admin');
  const activeHref = NAV_SECTIONS.flatMap((section) => section.items).find((item) => isNavItemActive(item, pathname))?.href;
  return <WorkspaceSidebar title={t('adminConsoleTitle')} logo={<Logo svgSize={28} wordmarkClass="hidden" />}
    groups={NAV_SECTIONS.map((section) => ({
      id: section.labelKey,
      items: section.items.map(({ labelKey, href, icon: Icon }) => ({ id: href, label: t(labelKey), icon: <Icon />, href })),
    }))}
    activeId={activeHref}
    footer={<div className="flex flex-col gap-1">
      <Link href="/app" className="flex min-h-9 items-center gap-2 overflow-hidden rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground [&_svg]:size-[18px]">
        <ArrowLeft aria-hidden="true" className="size-[18px] shrink-0" />
        <span className="truncate group-data-[state=collapsed]/sidebar:hidden">{t('adminBackToConsole')}</span>
      </Link>
    </div>} />;
}
