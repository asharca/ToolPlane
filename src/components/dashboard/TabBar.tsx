"use client";

import { Tabs, TabsList } from "@/components/motion/tabs";
import Link from "next/link";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export type Tab = { key: string; label: string; count?: number };

export function TabBar({
  tabs,
  current,
  basePath,
  query,
}: {
  tabs: Tab[];
  current: string;
  basePath: string;
  query?: Record<string, string | undefined>;
}) {
  return (
    <nav aria-label="Sections" className="max-w-full overflow-x-auto">
      <Tabs value={current} variant="underline" className="max-w-full">
        <TabsList>
          {tabs.map((tab) => {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(query ?? {}))
              if (value) params.set(key, value);
            if (tab.key !== tabs[0]?.key) params.set("tab", tab.key);
            const href = params.toString() ? `${basePath}?${params}` : basePath;
            return (
              <Link
                key={tab.key}
                href={href}
                scroll={false}
                role="tab"
                aria-selected={tab.key === current}
                aria-current={tab.key === current ? "page" : undefined}
                className={cn(
                  "relative isolate -mb-px inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap px-3 pb-2.5 pt-1 text-sm font-medium transition-colors",
                  tab.key === current
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {typeof tab.count === "number" ? (
                  <span className="text-muted-foreground">{tab.count}</span>
                ) : null}
                {tab.key === current ? (
                  <motion.span
                    layoutId="deployment-tabs-underline"
                    layout
                    className="absolute bottom-0 left-0 right-0 h-px bg-primary"
                  />
                ) : null}
              </Link>
            );
          })}
        </TabsList>
      </Tabs>
    </nav>
  );
}
