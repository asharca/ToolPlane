"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Search } from "lucide-react";
import { useAnimatedSidebar } from "@/components/motion/animated-sidebar";
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar";
import { Tooltip } from "@/components/motion/tooltip";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import type { WorkspaceCreationQuota } from "./WorkspaceForms";
import { AccountMenu } from "./AccountMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { DashboardCommandPalette } from "./DashboardCommandPalette";
import { SystemUpdateButton } from "./SystemUpdateButton";
import { pluginUpdateCountAction } from "@/lib/plugins/actions";
import { FEEDBACK_NAV_ITEM, WORKSPACE_NAV_GROUPS } from "./workspace-nav";

type Workspace = { id: string; slug: string; name: string };

export function DashboardSidebar({
  slug,
  workspaceName,
  userLabel,
  workspaces,
  quota,
  isAdmin = false,
}: {
  slug: string;
  workspaceName: string;
  userLabel: string;
  workspaces: Workspace[];
  quota: WorkspaceCreationQuota;
  isAdmin?: boolean;
}) {
  const pathname = usePathname() ?? "";
  const base = `/app/${slug}`;
  const t = useTranslations("console.sidebar");
  const pluginsT = useTranslations("console.plugins");
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { open, isMobile, setOpenMobile, toggleSidebar } = useAnimatedSidebar();
  const activePath = pathname.slice(`${base}/`.length);
  const activeSegment = activePath.split("/")[0];
  const activeId = activePath.startsWith("settings/account")
    ? ""
    : activeSegment === "agents"
      ? "work"
      : activeSegment;
  const compact = !open && !isMobile;
  const [updateCount, setUpdateCount] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation refreshes the update count.
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void pluginUpdateCountAction(slug)
        .then((count) => {
          if (active) setUpdateCount(count);
        })
        .catch(() => {
          if (active) setUpdateCount(0);
        });
    };
    refresh();
    window.addEventListener("plugins-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("plugins-changed", refresh);
    };
  }, [slug, pathname]);
  // Sidebar items are plain anchors; keep workspace navigation client-side.
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
    router.push(`${target.pathname}${target.search}`);
  }
  const mapNavItem = ({
    segment,
    labelKey,
    icon: Icon,
    badgeKey,
  }: (typeof WORKSPACE_NAV_GROUPS)[number]["items"][number]) => ({
    id: segment,
    label: t(labelKey),
    icon: <Icon />,
    href: `${base}/${segment}`,
    badge: badgeKey ? (
      <span className="text-[10px]">{t(badgeKey)}</span>
    ) : segment === "plugins" && updateCount > 0 ? (
      <span
        title={pluginsT("updatesBadge", { count: updateCount })}
        className="inline-flex rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums"
      >
        {updateCount}
      </span>
    ) : undefined,
  });
  const FeedbackIcon = FEEDBACK_NAV_ITEM.icon;
  return (
    <div className="contents" onClickCapture={navigate}>
      <WorkspaceSidebar
        title="ToolPlane"
        activeId={activeId}
        labels={{
          navigation: t("navigation"),
          closeNavigation: t("closeMenu"),
          expandSidebar: t("expandSidebar"),
          collapseSidebar: t("collapseSidebar"),
        }}
        onSelect={(id) => {
          if (id === "search") setPaletteOpen(true);
        }}
        groups={[
          {
            id: WORKSPACE_NAV_GROUPS[0].id,
            title: t(WORKSPACE_NAV_GROUPS[0].labelKey),
            items: [
              {
                id: "search",
                label: t("search"),
                icon: <Search />,
                badge: (
                  <kbd className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    ⌘K
                  </kbd>
                ),
              },
              ...WORKSPACE_NAV_GROUPS[0].items.map(mapNavItem),
            ],
          },
          ...WORKSPACE_NAV_GROUPS.slice(1).map((group) => ({
            id: group.id,
            title: t(group.labelKey),
            items: group.items.map(mapNavItem),
          })),
        ]}
        footer={
          <div className="flex flex-col gap-0.5">
            <Tooltip
              content={t("feedback")}
              open={compact ? undefined : false}
              side="right"
              wrapperClassName="flex w-full"
            >
              <Link
                href={`${base}/${FEEDBACK_NAV_ITEM.segment}`}
                aria-current={
                  activeId === FEEDBACK_NAV_ITEM.segment ? "page" : undefined
                }
                aria-label={compact ? t("feedback") : undefined}
                className={`flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg px-2 text-sm text-foreground transition-colors [&_svg]:size-[18px] ${
                  activeId === FEEDBACK_NAV_ITEM.segment
                    ? "bg-foreground/[0.08] font-medium"
                    : "hover:bg-foreground/5"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center"
                >
                  <FeedbackIcon className="size-[18px] shrink-0" />
                </span>
                <span className="truncate group-data-[state=collapsed]/sidebar:hidden">
                  {t("feedback")}
                </span>
              </Link>
            </Tooltip>
            {isAdmin ? (
              <SystemUpdateButton canInstall compact={compact} />
            ) : null}
            <NotificationBell workspaceSlug={slug} compact={compact} />
            <WorkspaceSwitcher
              slug={slug}
              workspaceName={workspaceName}
              userLabel={userLabel}
              workspaces={workspaces}
              quota={quota}
              compact={compact}
            />
            <AccountMenu
              userLabel={userLabel}
              workspaceSlug={slug}
              returnTo={pathname}
              isAdmin={isAdmin}
              compact={compact}
            />
          </div>
        }
      />
      <DashboardCommandPalette
        open={paletteOpen}
        pluginUpdateCount={updateCount}
        workspaces={workspaces}
        currentSlug={slug}
        onToggleSidebar={toggleSidebar}
        onOpenChange={setPaletteOpen}
      />
    </div>
  );
}
