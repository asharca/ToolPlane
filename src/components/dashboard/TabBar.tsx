"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export type Tab = {
  key: string;
  label: string;
  count?: number;
  badge?: ReactNode;
  href?: string;
};

export function TabBar({
  tabs,
  current,
  basePath,
  query,
  param = "tab",
  ariaLabel,
}: {
  tabs: Tab[];
  current: string;
  basePath: string;
  query?: Record<string, string | undefined>;
  param?: string;
  ariaLabel?: string;
}) {
  const common = useTranslations("common");
  const layoutId = useId();
  const reduce = useReducedMotion() ?? false;
  return (
    <nav
      aria-label={ariaLabel ?? common("sections")}
      className="max-w-full overflow-x-auto scrollbar-hide"
    >
      <div className="inline-flex min-w-full items-center gap-1 border-b border-border">
        {tabs.map((tab) => {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(query ?? {}))
            if (value) params.set(key, value);
          if (tab.key !== tabs[0]?.key) params.set(param, tab.key);
          const href =
            tab.href ??
            (params.toString() ? `${basePath}?${params}` : basePath);
          return (
            <Link
              key={tab.key}
              href={href}
              scroll={false}
              aria-current={tab.key === current ? "page" : undefined}
              className={cn(
                "relative isolate -mb-px inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-t-md px-3 pb-2.5 pt-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                tab.key === current
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.badge ? (
                <span className="ml-1.5 inline-flex items-center">
                  {tab.badge}
                </span>
              ) : typeof tab.count === "number" ? (
                <span className="ml-1.5 tabular-nums text-muted-foreground">
                  {tab.count}
                </span>
              ) : null}
              {tab.key === current ? (
                <motion.span
                  layoutId={
                    reduce ? undefined : `${layoutId}-deployment-tabs-underline`
                  }
                  layout={!reduce}
                  transition={reduce ? { duration: 0 } : undefined}
                  className="absolute bottom-0 left-0 right-0 h-px bg-primary"
                />
              ) : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
