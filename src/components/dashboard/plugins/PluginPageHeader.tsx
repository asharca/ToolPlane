"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { DashboardToolbar } from "@/components/dashboard/DashboardUI";
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
      <DashboardToolbar actions={actions}>
        <h1 className="text-xl font-semibold">{t("pageTitle")}</h1>
      </DashboardToolbar>
      <TabBar
        basePath={base}
        current={current}
        tabs={[
          { key: "catalog", label: t("title"), href: base },
          {
            key: "installed",
            label: t("installed.title"),
            href: `${base}/installed`,
            count: updateCount > 0 ? updateCount : undefined,
          },
        ]}
      />
    </>
  );
}
