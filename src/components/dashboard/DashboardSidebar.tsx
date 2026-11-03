"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Bot,
  Boxes,
  Brain,
  Cpu,
  LibraryBig,
  MessageSquare,
  Plug,
  ScrollText,
  Search,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAnimatedSidebar } from "@/components/motion/animated-sidebar";
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AccountMenu } from "./AccountMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { DashboardCommandPalette } from "./DashboardCommandPalette";
import { SystemUpdateButton } from "./SystemUpdateButton";
import { pluginUpdateCountAction } from "@/lib/plugins/actions";

type NavItem = { labelKey: string; segment: string; icon: LucideIcon };
type Workspace = { id: string; slug: string; name: string };
// Daily work first, then what agents are built from, then workspace setup.
const NAV_ITEMS: NavItem[] = [
  { labelKey: "chat", segment: "chat", icon: MessageSquare },
  { labelKey: "agents", segment: "agents", icon: Bot },
];
const BUILD_ITEMS: NavItem[] = [
  { labelKey: "mcpServers", segment: "mcp", icon: Plug },
  { labelKey: "skills", segment: "skills", icon: Brain },
  {
    labelKey: "knowledgeInDevelopment",
    segment: "knowledge",
    icon: LibraryBig,
  },
  { labelKey: "plugins", segment: "plugins", icon: Store },
];
const MANAGE_ITEMS: NavItem[] = [
  { labelKey: "modelProviders", segment: "providers", icon: Cpu },
  { labelKey: "sandboxes", segment: "sandboxes", icon: Boxes },
  { labelKey: "observability", segment: "observability", icon: ScrollText },
  { labelKey: "members", segment: "members", icon: Users },
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
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { open, isMobile, setOpenMobile } = useAnimatedSidebar();
  const activeSegment = pathname.slice(`${base}/`.length).split("/")[0];
  const activeId = activeSegment === "work" ? "agents" : activeSegment;
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
  return (
    <div className="contents" onClickCapture={navigate}>
      <WorkspaceSidebar
        title="ToolPlane"
        activeId={activeId}
        onSelect={(id) => {
          if (id === "search") setPaletteOpen(true);
        }}
        groups={[
          {
            id: "workspace",
            items: [
              {
                id: "search",
                label: t("search"),
                icon: <Search />,
              },
              ...NAV_ITEMS.map(({ segment, labelKey, icon: Icon }) => ({
                id: segment,
                label: t(labelKey),
                icon: <Icon />,
                href: `${base}/${segment}`,
              })),
            ],
          },
          {
            id: "build",
            title: t("build"),
            items: BUILD_ITEMS.map(({ segment, labelKey, icon: Icon }) => ({
              id: segment,
              label: t(labelKey),
              icon: <Icon />,
              href: `${base}/${segment}`,
              badge:
                segment === "plugins" && updateCount > 0
                  ? updateCount
                  : undefined,
            })),
          },
          {
            id: "manage",
            title: t("manage"),
            items: MANAGE_ITEMS.map(({ segment, labelKey, icon: Icon }) => ({
              id: segment,
              label: t(labelKey),
              icon: <Icon />,
              href: `${base}/${segment}`,
            })),
          },
        ]}
        footer={
          <div className="flex flex-col gap-0.5">
            <SystemUpdateButton
              canInstall={isAdmin}
              compact={!open && !isMobile}
            />
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
      <DashboardCommandPalette
        open={paletteOpen}
        pluginUpdateCount={updateCount}
        onOpenChange={setPaletteOpen}
      />
    </div>
  );
}
