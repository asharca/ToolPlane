"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { ThemeToggle as BeUIThemeToggle } from "@/components/motion/theme-toggle";

const subscribe = () => () => {};

export function ThemeToggle({
  showLabel = false,
}: {
  showLabel?: boolean;
} = {}) {
  const t = useTranslations("common");
  const { resolvedTheme, forcedTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  if (forcedTheme) return null;
  const isDark = mounted && resolvedTheme === "dark";
  const label = !mounted
    ? t("toggleTheme")
    : isDark
      ? t("switchToLightTheme")
      : t("switchToDarkTheme");

  const toggle = (
    <BeUIThemeToggle
      aria-label={label}
      aria-pressed={mounted ? isDark : undefined}
      className="size-8 rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      iconClassName="size-4"
    />
  );

  if (showLabel) {
    return (
      <span className="inline-flex items-center gap-2">
        {mounted ? (
          <span className="text-xs text-muted-foreground">
            {isDark ? t("themeDark") : t("themeLight")}
          </span>
        ) : null}
        {toggle}
      </span>
    );
  }

  return toggle;
}
