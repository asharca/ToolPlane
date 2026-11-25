"use client";

import { MotionConfig } from "motion/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      enableColorScheme={false}
      {...props}
      scriptProps={{
        ...props.scriptProps,
        // The bootstrap runs during SSR; client mounts apply the theme through effects.
        type:
          typeof window === "undefined"
            ? "text/javascript"
            : "application/json",
      }}
    >
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </NextThemesProvider>
  );
}
