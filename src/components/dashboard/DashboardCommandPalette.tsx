"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Sun,
  Moon,
  Plug,
  Brain,
  Boxes,
  Bot,
  BarChart3,
  Code2,
  Users,
  Home,
  MessageSquare,
  PackageCheck,
  Settings,
  Store,
  TerminalSquare,
} from "lucide-react";
import {
  CommandPalette,
  type CommandItem,
} from "@/components/motion/command-palette";
import { useThemeToggle } from "@/components/motion/theme-toggle";
import { SITE } from "@/lib/site";

function workspaceSlug(pathname: string): string | null {
  const parts = pathname.split("/");
  return parts[1] === "app" && parts[2] ? parts[2] : null;
}

/** Workspace quick navigation; the sidebar owns the trigger and open state. */
export function DashboardCommandPalette({
  open,
  onOpenChange,
  pluginUpdateCount = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginUpdateCount?: number;
}) {
  const t = useTranslations("console.header");
  const sidebarT = useTranslations("console.sidebar");
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const returnTo = `${pathname}${queryString ? `?${queryString}` : ""}`;
  const { isDark, toggle: toggleTheme } = useThemeToggle();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = document
        .querySelector('[role="dialog"] [role="combobox"]')
        ?.closest('[role="dialog"]');
      const controls = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'input, button:not(:disabled), [tabindex="0"]',
        ) ?? [],
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [open]);

  const closePalette = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const commands = useMemo<CommandItem[]>(() => {
    const slug = workspaceSlug(pathname);
    const go = (href: string) => () => {
      closePalette();
      router.push(href);
    };
    const openExternal = (href: string) => () => {
      closePalette();
      window.open(href, "_blank", "noopener,noreferrer");
    };
    const list: CommandItem[] = [];
    if (slug) {
      const b = `/app/${slug}`;
      list.push(
        {
          id: "mcp",
          label: t("mcp"),
          group: t("groupBuild"),
          icon: Plug,
          onSelect: go(`${b}/mcp`),
        },
        {
          id: "skills",
          label: t("skills"),
          group: t("groupBuild"),
          icon: Brain,
          onSelect: go(`${b}/skills`),
        },
        {
          id: "agents",
          label: t("agents"),
          group: t("groupRun"),
          icon: Bot,
          onSelect: go(`${b}/agents`),
        },
        {
          id: "sandboxes",
          label: t("sandboxes"),
          group: t("groupBuild"),
          icon: Boxes,
          onSelect: go(`${b}/sandboxes`),
        },
        {
          id: "chat",
          label: t("chat"),
          group: t("groupRun"),
          icon: MessageSquare,
          onSelect: go(`${b}/chat`),
        },
        {
          id: "my-plugins",
          label: `${sidebarT("myPlugins")}${pluginUpdateCount > 0 ? ` (${pluginUpdateCount})` : ""}`,
          group: t("groupRun"),
          icon: PackageCheck,
          onSelect: go(`${b}/plugins/installed`),
        },
        {
          id: "plugins",
          label: sidebarT("plugins"),
          group: t("groupRun"),
          icon: Store,
          onSelect: go(`${b}/plugins`),
        },
        {
          id: "work",
          label: t("work"),
          group: t("groupRun"),
          icon: TerminalSquare,
          onSelect: go(`${b}/work`),
        },
        {
          id: "obs",
          label: t("logs"),
          group: t("groupOperate"),
          icon: BarChart3,
          onSelect: go(`${b}/observability`),
        },
        {
          id: "members",
          label: t("members"),
          group: t("groupWorkspace"),
          icon: Users,
          onSelect: go(`${b}/members`),
        },
        {
          id: "settings",
          label: t("settings"),
          group: t("groupWorkspace"),
          icon: Settings,
          onSelect: go(
            `${b}/settings?returnTo=${encodeURIComponent(returnTo)}`,
          ),
        },
      );
    }
    list.push(
      {
        id: "home",
        label: t("backToToolPlane"),
        group: t("groupActions"),
        icon: Home,
        onSelect: go("/"),
      },
      {
        id: "source",
        label: t("sourceCode"),
        group: t("groupProject"),
        icon: Code2,
        onSelect: openExternal(SITE.sourceUrl),
      },
      {
        id: "theme",
        label: t("toggleDarkMode"),
        group: t("groupActions"),
        icon: isDark ? Sun : Moon,
        onSelect: () => {
          toggleTheme();
          closePalette();
        },
      },
    );
    return list;
  }, [
    closePalette,
    pathname,
    isDark,
    returnTo,
    router,
    t,
    sidebarT,
    pluginUpdateCount,
    toggleTheme,
  ]);

  return (
    <CommandPalette
      items={commands}
      open={open}
      onOpenChange={onOpenChange}
      placeholder={t("searchNavigation")}
      emptyMessage={t("noResults")}
    />
  );
}
