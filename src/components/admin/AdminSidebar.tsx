"use client";

import {
  ArrowLeft,
  Bell,
  Gauge,
  Building2,
  LayoutDashboard,
  Library,
  Settings,
  ScrollText,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useAnimatedSidebar } from "@/components/motion/animated-sidebar";

type AdminPageLabelKey =
  | "adminNavOverview"
  | "adminNavSettings"
  | "adminNavLogs"
  | "adminNavPerformance"
  | "adminNavUsers"
  | "adminNavWorkspaces"
  | "adminNavCatalog"
  | "adminNavNotifications";

type AdminSectionLabelKey =
  | "adminNavOperations"
  | "adminNavAccess"
  | "adminNavPlatform";

type NavItem = {
  labelKey: AdminPageLabelKey;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};
type NavSection = { labelKey: AdminSectionLabelKey; items: NavItem[] };

const NAV_SECTIONS: NavSection[] = [
  {
    labelKey: "adminNavOperations",
    items: [
      {
        labelKey: "adminNavOverview",
        href: "/admin",
        icon: LayoutDashboard,
        exact: true,
      },
      { labelKey: "adminNavLogs", href: "/admin/logs", icon: ScrollText },
      {
        labelKey: "adminNavPerformance",
        href: "/admin/performance",
        icon: Gauge,
      },
    ],
  },
  {
    labelKey: "adminNavAccess",
    items: [
      { labelKey: "adminNavUsers", href: "/admin/users", icon: Users },
      {
        labelKey: "adminNavWorkspaces",
        href: "/admin/workspaces",
        icon: Building2,
      },
    ],
  },
  {
    labelKey: "adminNavPlatform",
    items: [
      { labelKey: "adminNavCatalog", href: "/admin/market", icon: Library },
      {
        labelKey: "adminNavNotifications",
        href: "/admin/notifications",
        icon: Bell,
      },
      { labelKey: "adminNavSettings", href: "/admin/settings", icon: Settings },
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
  return "adminNavOverview";
}

export function AdminSidebar() {
  const pathname = usePathname() ?? "/admin";
  const t = useTranslations("admin");
  const { open, isMobile } = useAnimatedSidebar();
  const activeHref = NAV_SECTIONS.flatMap((section) => section.items).find(
    (item) => isNavItemActive(item, pathname),
  )?.href;
  return (
    <WorkspaceSidebar
      title={t("adminConsoleTitle")}
      groups={NAV_SECTIONS.map((section) => ({
        id: section.labelKey,
        title: t(section.labelKey),
        items: section.items.map(({ labelKey, href, icon: Icon }) => ({
          id: href,
          label: t(labelKey),
          icon: <Icon />,
          href,
        })),
      }))}
      activeId={activeHref}
      footer={
        <div className="flex flex-col gap-0.5">
          <NotificationBell compact={!open && !isMobile} />
          <Link
            href="/app"
            className="flex h-9 items-center gap-[9px] overflow-hidden rounded-lg px-[9px] text-sm text-foreground transition-colors hover:bg-foreground/5 [&_svg]:size-[18px]"
          >
            <ArrowLeft aria-hidden="true" className="size-[18px] shrink-0" />
            <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
              {t("adminBackToConsole")}
            </span>
          </Link>
        </div>
      }
    />
  );
}
