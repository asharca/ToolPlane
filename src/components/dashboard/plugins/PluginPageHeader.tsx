"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { TabBar } from "@/components/dashboard/TabBar";

export function PluginPageHeader({
  base,
  current,
  updateCount,
  actions,
}: {
  base: string;
  current: "catalog" | "installed";
  updateCount: number;
  actions?: ReactNode;
}) {
  const t = useTranslations("console.plugins");
  return (
    <>
      <DashboardHeader title={t("pageTitle")} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabBar
          basePath={base}
          current={current}
          tabs={[
            { key: "catalog", label: t("title"), href: base },
            {
              key: "installed",
              label: t("installed.title"),
              href: `${base}/installed`,
              badge:
                updateCount > 0 ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary tabular-nums">
                    {t("updatesBadge", { count: updateCount })}
                  </span>
                ) : undefined,
            },
          ]}
        />
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </>
  );
}
