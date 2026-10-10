"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Search,
  Sun,
  Moon,
  Plug,
  Brain,
  Wrench,
  Boxes,
  Bot,
  BarChart3,
  Code2,
  Users,
  Home,
  MessageSquare,
  Settings,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/motion/button/base";
import {
  CommandPalette,
  type CommandItem,
} from "@/components/motion/command-palette";
import { useThemeToggle } from "@/components/motion/theme-toggle";
import { SITE } from "@/lib/site";
import { SystemUpdateButton } from "./SystemUpdateButton";

function workspaceSlug(pathname: string): string | null {
  const parts = pathname.split("/");
  return parts[1] === "app" && parts[2] ? parts[2] : null;
}

export function DashboardHeaderControls({
  canInstall = false,
}: {
  canInstall?: boolean;
}) {
  const t = useTranslations("console.header");
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const returnTo = `${pathname}${queryString ? `?${queryString}` : ""}`;
  const { isDark, toggle: toggleTheme } = useThemeToggle();
  const [open, setOpen] = useState(false);
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
    setOpen(false);
  }, []);

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
          id: "toolkits",
          label: t("toolkits"),
          group: t("groupBuild"),
          icon: Wrench,
          onSelect: go(`${b}/toolkits`),
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
        {
          id: "browse-mcp",
          label: t("browseMcp"),
          group: t("groupDiscover"),
          icon: Plug,
          onSelect: go(`${b}/market/mcp`),
        },
        {
          id: "browse-skills",
          label: t("browseSkills"),
          group: t("groupDiscover"),
          icon: Brain,
          onSelect: go(`${b}/market/skills`),
        },
        {
          id: "browse-agents",
          label: t("browseAgents"),
          group: t("groupDiscover"),
          icon: Bot,
          onSelect: go(`${b}/market/agents`),
        },
        {
          id: "browse-toolkits",
          label: t("browseToolkits"),
          group: t("groupDiscover"),
          icon: Wrench,
          onSelect: go(`${b}/market/toolkits`),
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
  }, [closePalette, pathname, isDark, returnTo, router, t, toggleTheme]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("quickNavigation")}
        title={t("quickNavigation")}
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
      </Button>
      <CommandPalette
        items={commands}
        open={open}
        onOpenChange={setOpen}
        placeholder={t("searchNavigation")}
        emptyMessage={t("noResults")}
      />

      <SystemUpdateButton canInstall={canInstall} />
    </>
  );
}
