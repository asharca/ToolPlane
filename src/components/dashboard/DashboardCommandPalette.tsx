"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sun, Moon, Code2, Home } from "lucide-react";
import {
  CommandPalette,
  type CommandItem,
} from "@/components/motion/command-palette";
import { useThemeToggle } from "@/components/motion/theme-toggle";
import { SITE } from "@/lib/site";
import { FEEDBACK_NAV_ITEM, WORKSPACE_NAV_GROUPS } from "./workspace-nav";

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
      for (const group of WORKSPACE_NAV_GROUPS) {
        for (const item of group.items) {
          list.push({
            id: item.segment,
            label: sidebarT(item.labelKey),
            group: sidebarT(group.labelKey),
            icon: item.icon,
            badge: item.badgeKey
              ? sidebarT(item.badgeKey)
              : item.segment === "plugins" && pluginUpdateCount > 0
                ? pluginUpdateCount
                : undefined,
            onSelect: go(`${b}/${item.segment}`),
          });
        }
      }
      list.push({
        id: FEEDBACK_NAV_ITEM.segment,
        label: sidebarT("feedback"),
        group: t("groupActions"),
        icon: FEEDBACK_NAV_ITEM.icon,
        onSelect: go(`${b}/${FEEDBACK_NAV_ITEM.segment}`),
      });
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
        label: t(isDark ? "switchToLightMode" : "switchToDarkMode"),
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
