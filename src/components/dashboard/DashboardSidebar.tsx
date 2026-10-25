"use client";

import type { MouseEvent } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Logo } from "@/components/layout/Logo";
import {
  Bot,
  Store,
  MessageSquare,
  LibraryBig,
  Settings,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { useAnimatedSidebar } from "@/components/motion/animated-sidebar";
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AccountMenu } from "./AccountMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useDashboardTabs } from "./DashboardTabs";
import { ButtonLink } from "@/components/motion/button";

type NavItem = { labelKey: string; segment: string; icon: LucideIcon };
type Workspace = { id: string; slug: string; name: string };
const NAV_ITEMS: NavItem[] = [
  { labelKey: "chat", segment: "chat", icon: MessageSquare },
  { labelKey: "agents", segment: "agents", icon: Bot },
  { labelKey: "market", segment: "market", icon: Store },
];
const SECONDARY_ITEMS: NavItem[] = [
  { labelKey: "knowledge", segment: "knowledge", icon: LibraryBig },
  { labelKey: "observability", segment: "observability", icon: ScrollText },
];

export function DashboardSidebar({
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
  const pathname = usePathname() ?? "";
  const base = `/app/${slug}`;
  const t = useTranslations("console.sidebar");
  const { openRoute } = useDashboardTabs();
  const { open, isMobile, setOpenMobile } = useAnimatedSidebar();
  const activeSegment = pathname.slice(`${base}/`.length).split("/")[0];
  const activeId =
    activeSegment === "work" || activeSegment === "sandboxes"
      ? "agents"
      : ["mcp", "skills", "toolkits", "seller"].includes(activeSegment)
        ? "market"
        : ["members", "providers"].includes(activeSegment)
          ? "settings"
          : activeSegment;
  function navigate(event: MouseEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (!link || link.target === "_blank") return;
    const target = new URL(link.href, window.location.href);
    if (
      target.origin !== window.location.origin ||
      !target.pathname.startsWith(`${base}/`)
    )
      return;
    event.preventDefault();
    if (isMobile) setOpenMobile(false);
    openRoute(`${target.pathname}${target.search}`);
  }
  return (
    <div className="contents" onClickCapture={navigate}>
      <WorkspaceSidebar
        title="ToolPlane"
        logo={<Logo svgSize={28} wordmarkClass="hidden" />}
        activeId={activeId}
        groups={[
          {
            id: "workspace",
            items: NAV_ITEMS.map(({ segment, labelKey, icon: Icon }) => ({
              id: segment,
              label: t(labelKey),
              icon: <Icon />,
              href: `${base}/${segment}`,
            })),
          },
          {
            id: "secondary",
            items: SECONDARY_ITEMS.map(({ segment, labelKey, icon: Icon }) => ({
              id: segment,
              label: t(labelKey),
              icon: <Icon />,
              href: `${base}/${segment}`,
            })),
          },
        ]}
        footer={
          <div className="flex flex-col gap-1">
            <ButtonLink
              href={`${base}/settings?returnTo=${encodeURIComponent(pathname)}`}
              variant={activeId === "settings" ? "secondary" : "ghost"}
              size="sm"
              aria-current={activeId === "settings" ? "page" : undefined}
              aria-label={t("settings")}
              title={t("settings")}
              className={
                !open && !isMobile ? "justify-center px-0" : "justify-start"
              }
            >
              <Settings className="size-4 shrink-0" />
              <span className={!open && !isMobile ? "sr-only" : undefined}>
                {t("settings")}
              </span>
            </ButtonLink>
            <NotificationBell
              workspaceSlug={slug}
              compact={!open && !isMobile}
            />
            <WorkspaceSwitcher
              slug={slug}
              workspaceName={workspaceName}
              userLabel={userLabel}
              workspaces={workspaces}
              compact={!open && !isMobile}
            />
            <AccountMenu
              userLabel={userLabel}
              workspaceSlug={slug}
              returnTo={pathname}
              isAdmin={isAdmin}
              compact={!open && !isMobile}
            />
          </div>
        }
      />
    </div>
  );
}
