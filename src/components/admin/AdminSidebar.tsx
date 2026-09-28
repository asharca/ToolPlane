'use client';

import {
  ArrowLeft,
  Bot,
  Brain,
  Building2,
  ClipboardCheck,
  LayoutDashboard,
  Library,
  MessageSquare,
  Plug,
  Settings,
  ScrollText,
  ShieldCheck,
  Tags,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/layout/Logo';
import {
  AnimatedSidebar,
  AnimatedSidebarClose,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarHeader,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
} from '@/components/motion/animated-sidebar';
import { Tooltip } from '@/components/motion/tooltip';

type AdminPageLabelKey =
  | 'adminNavOverview'
  | 'adminNavSettings'
  | 'adminNavLogs'
  | 'adminNavUsers'
  | 'adminNavWorkspaces'
  | 'adminNavMcpServers'
  | 'adminNavSkills'
  | 'adminNavAgents'
  | 'adminNavAssistants'
  | 'adminNavMarketReviews'
  | 'adminNavCatalog'
  | 'adminNavCategories';

type AdminSectionLabelKey =
  | 'adminNavOperations'
  | 'adminNavAccess'
  | 'adminNavDirectory';

type NavItem = {
  labelKey: AdminPageLabelKey;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};

type NavSection = {
  labelKey: AdminSectionLabelKey;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    labelKey: 'adminNavOperations',
    items: [
      {
        labelKey: 'adminNavOverview',
        href: '/admin',
        icon: LayoutDashboard,
        exact: true,
      },
      { labelKey: 'adminNavLogs', href: '/admin/logs', icon: ScrollText },
      { labelKey: 'adminNavMarketReviews', href: '/admin/reviews', icon: ClipboardCheck },
      { labelKey: 'adminNavSettings', href: '/admin/settings', icon: Settings },
    ],
  },
  {
    labelKey: 'adminNavAccess',
    items: [
      { labelKey: 'adminNavUsers', href: '/admin/users', icon: Users },
      {
        labelKey: 'adminNavWorkspaces',
        href: '/admin/workspaces',
        icon: Building2,
      },
    ],
  },
  {
    labelKey: 'adminNavDirectory',
    items: [
      {
        labelKey: 'adminNavCatalog',
        href: '/admin/market',
        icon: Library,
      },
      {
        labelKey: 'adminNavMcpServers',
        href: '/admin/servers',
        icon: Plug,
      },
      { labelKey: 'adminNavSkills', href: '/admin/skills', icon: Brain },
      { labelKey: 'adminNavAgents', href: '/admin/agents', icon: Bot },
      {
        labelKey: 'adminNavAssistants',
        href: '/admin/assistants',
        icon: MessageSquare,
      },
      {
        labelKey: 'adminNavCategories',
        href: '/admin/categories',
        icon: Tags,
      },
    ],
  },
];

function isNavItemActive(item: NavItem, pathname: string): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function getAdminPageLabelKey(pathname: string): AdminPageLabelKey {
  for (const section of NAV_SECTIONS) {
    const activeItem = section.items.find((item) =>
      isNavItemActive(item, pathname),
    );
    if (activeItem) return activeItem.labelKey;
  }

  return 'adminNavOverview';
}

export function AdminSidebar() {
  const pathname = usePathname() ?? '/admin';
  const t = useTranslations('admin');

  return (
    <AnimatedSidebar id="admin-sidebar" ariaLabel={t('adminNavigation')}>
      <AnimatedSidebarHeader>
        <div className="flex items-center justify-between gap-2">
          <Link href="/admin" aria-label={t('adminConsoleTitle')}>
            <Logo wordmarkClass="text-xl" />
          </Link>
          <Tooltip content={t('adminCloseMenu')} wrapperClassName="md:hidden"><AnimatedSidebarClose aria-label={t('adminCloseMenu')} /></Tooltip>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
          <ShieldCheck className="size-3" aria-hidden="true" />
          {t('adminConsoleTitle')}
        </span>
      </AnimatedSidebarHeader>
      <AnimatedSidebarContent>
        <nav aria-label={t('adminNavigation')}>
          {NAV_SECTIONS.map((section) => (
            <AnimatedSidebarGroup key={section.labelKey}>
              <AnimatedSidebarGroupLabel>{t(section.labelKey)}</AnimatedSidebarGroupLabel>
              <AnimatedSidebarMenu>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <AnimatedSidebarMenuItem key={item.href}>
                      <AnimatedSidebarMenuButton
                        href={item.href}
                        icon={<Icon className="size-4" />}
                        isActive={isNavItemActive(item, pathname)}
                      >
                        {t(item.labelKey)}
                      </AnimatedSidebarMenuButton>
                    </AnimatedSidebarMenuItem>
                  );
                })}
              </AnimatedSidebarMenu>
            </AnimatedSidebarGroup>
          ))}
        </nav>
      </AnimatedSidebarContent>
      <AnimatedSidebarFooter>
        <AnimatedSidebarMenu>
          <AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuButton href="/app" icon={<ArrowLeft className="size-4" />}>
              {t('adminBackToConsole')}
            </AnimatedSidebarMenuButton>
          </AnimatedSidebarMenuItem>
        </AnimatedSidebarMenu>
      </AnimatedSidebarFooter>
    </AnimatedSidebar>
  );
}
