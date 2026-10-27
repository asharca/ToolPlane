"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ButtonLink } from "@/components/motion/button";
import {
  DashboardEmptyState,
  DashboardFilterInput,
  DashboardPage,
  DashboardTable,
  DashboardToolbar,
} from "./DashboardUI";

export type ToolkitRow = {
  id: string;
  name: string;
  slug: string;
  visibility: string;
  enabled: boolean;
  toolCount: number;
  created: string;
};

export function ToolkitsBrowser({
  slug,
  toolkits,
}: {
  slug: string;
  toolkits: ToolkitRow[];
}) {
  const t = useTranslations("console.toolkits");
  const [query, setQuery] = useState("");
  const filtered = toolkits.filter((toolkit) =>
    toolkit.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const base = `/app/${encodeURIComponent(slug)}`;
  return (
    <DashboardPage className="space-y-4">
      <DashboardToolbar
        actions={
          <ButtonLink
            href={`${base}/market/pi-packages`}
            variant="secondary"
            size="sm"
          >
            {t("browsePiPackages")}
          </ButtonLink>
        }
      >
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("historyReadOnly")}
        </p>
      </DashboardToolbar>
      <DashboardFilterInput
        value={query}
        onChange={setQuery}
        placeholder={t("searchToolkits")}
      />
      {!filtered.length ? (
        <DashboardEmptyState description={t("historyEmpty")} />
      ) : (
        <DashboardTable
          headers={[
            { label: t("toolkitColumn") },
            { label: t("historySavedState") },
            { label: t("tools") },
            { label: t("created") },
          ]}
          rows={filtered.map((toolkit) => ({
            id: toolkit.id,
            cells: [
              <Link
                key="name"
                href={`${base}/toolkits/${encodeURIComponent(toolkit.slug)}`}
                className="break-words font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {toolkit.name}
              </Link>,
              `${toolkit.visibility === "public" ? t("public") : t("private")} · ${toolkit.enabled ? t("enabled") : t("disabled")}`,
              toolkit.toolCount,
              toolkit.created,
            ],
          }))}
        />
      )}
    </DashboardPage>
  );
}
