"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import "@scalar/api-reference-react/style.css";

const subscribe = () => () => {};

const SCALAR_CUSTOM_CSS = `
.scalar-app,
.light-mode,
.dark-mode {
  --scalar-font: var(--font-sans);
  --scalar-font-code: var(--font-mono);
  --scalar-background-1: var(--background);
  --scalar-background-2: var(--card);
  --scalar-background-3: color-mix(in oklch, var(--card) 85%, var(--foreground));
  --scalar-color-1: var(--foreground);
  --scalar-color-2: var(--muted-foreground);
  --scalar-color-3: color-mix(in oklch, var(--muted-foreground) 72%, transparent);
  --scalar-color-accent: var(--primary);
  --scalar-border-color: var(--border-strong);
}
`;

export function Reference({ locale = "en" }: { locale?: string }) {
  const { resolvedTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  if (!mounted) {
    return (
      <div
        aria-busy="true"
        className="min-h-[calc(100dvh-3rem)] bg-background"
      />
    );
  }

  const isDark = resolvedTheme !== "light";
  const scalarLocale = locale.toLowerCase().startsWith("zh") ? "zh-cn" : "en";

  return (
    <ApiReferenceReact
      configuration={{
        url: "/api/v1/openapi.json",
        darkMode: isDark,
        forceDarkModeState: isDark ? "dark" : "light",
        hideDarkModeToggle: true,
        withDefaultFonts: false,
        customCss: SCALAR_CUSTOM_CSS,
        localization: {
          locale: scalarLocale,
        },
        persistAuth: false,
        hideClientButton: true,
        agent: { disabled: true },
        mcp: { disabled: true },
        showDeveloperTools: "never",
        hideTestRequestButton: false,
      }}
    />
  );
}
