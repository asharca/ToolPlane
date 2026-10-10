"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { ThemeToggle as BeUIThemeToggle } from "@/components/motion/theme-toggle";

const subscribe = () => () => {};

export function ThemeToggle() {
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

  return (
    <BeUIThemeToggle
      aria-label={label}
      aria-pressed={mounted ? isDark : undefined}
      className="size-8"
      iconClassName="size-4"
    />
  );
}
