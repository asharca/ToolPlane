"use client";

import {
  ArrowLeft,
  Flag,
  Gauge,
  Building2,
  LayoutDashboard,
  Library,
  Megaphone,
  Settings,
  ScrollText,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar";
import { AccountMenu } from "@/components/dashboard/AccountMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useAnimatedSidebar } from "@/components/motion/animated-sidebar";
import { Tooltip } from "@/components/motion/tooltip";

type AdminPageLabelKey =
  | "adminNavOverview"
  | "adminNavSettings"
  | "adminNavLogs"
  | "adminNavPerformance"
  | "adminNavUsers"
  | "adminNavWorkspaces"
  | "adminNavCatalog"
  | "adminNavNotifications"
  | "adminNavFeedback";

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
        icon: Megaphone,
      },
      {
        labelKey: "adminNavFeedback",
        href: "/admin/feedback",
        icon: Flag,
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

export function AdminSidebar({ userLabel }: { userLabel?: string } = {}) {
  const pathname = usePathname() ?? "/admin";
  const t = useTranslations("admin");
  const sidebar = useTranslations("console.sidebar");
  const { open, isMobile } = useAnimatedSidebar();
  const compact = !open && !isMobile;
  const activeHref = NAV_SECTIONS.flatMap((section) => section.items).find(
    (item) => isNavItemActive(item, pathname),
  )?.href;
  return (
    <WorkspaceSidebar
      title={t("adminConsoleTitle")}
      labels={{
        navigation: sidebar("navigation"),
        closeNavigation: sidebar("closeMenu"),
        expandSidebar: sidebar("expandSidebar"),
        collapseSidebar: sidebar("collapseSidebar"),
      }}
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
          <NotificationBell compact={compact} />
          <Tooltip
            content={t("adminBackToConsole")}
            open={compact ? undefined : false}
            side="right"
            wrapperClassName="flex w-full"
          >
            <Link
              href="/app"
              aria-label={compact ? t("adminBackToConsole") : undefined}
              className="flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg px-2 text-sm text-foreground transition-colors hover:bg-foreground/5 [&_svg]:size-[18px]"
            >
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center"
              >
                <ArrowLeft className="size-[18px] shrink-0" />
              </span>
              <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
                {t("adminBackToConsole")}
              </span>
            </Link>
          </Tooltip>
          {userLabel ? (
            <AccountMenu userLabel={userLabel} compact={compact} isAdmin />
          ) : null}
        </div>
      }
    />
  );
}
