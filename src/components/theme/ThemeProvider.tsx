"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  const pathname = usePathname();
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      enableColorScheme={false}
      {...props}
      forcedTheme={pathname === "/" ? "dark" : props.forcedTheme}
      scriptProps={{
        ...props.scriptProps,
        // The bootstrap runs during SSR; client mounts apply the theme through effects.
        type:
          typeof window === "undefined"
            ? "text/javascript"
            : "application/json",
      }}
    >
      {children}
    </NextThemesProvider>
  );
}
