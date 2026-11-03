"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { DashboardTable } from "@/components/dashboard/DashboardUI";
import type { A2ATaskSummary } from "@/lib/observability/views/types";
import {
  Duration,
  EmptyState,
  RelativeTime,
  StatusBadge,
} from "./LogPrimitives";

export function A2ATaskTable({
  items,
  detailBase,
  showWorkspace = false,
  returnTo,
}: {
  items: A2ATaskSummary[];
  detailBase: string;
  showWorkspace?: boolean;
  returnTo?: string;
}) {
  const t = useTranslations("console.observability.viewer");
  if (!items.length) return <EmptyState />;
  return (
    <DashboardTable
      minWidth="48rem"
      headers={[
        ...(showWorkspace ? [{ label: t("workspace") }] : []),
        { label: t("task") },
        { label: t("from") },
        { label: t("to") },
        { label: t("status") },
        { label: t("duration") },
        { label: t("time") },
      ]}
      rows={items.map((item) => ({
        id: item.taskId,
        cells: [
          ...(showWorkspace ? [item.workspace?.name ?? "—"] : []),
          <Link
            key="task"
            href={`${detailBase}/${encodeURIComponent(item.taskId)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
            className="font-medium text-primary hover:underline"
          >
            <span className="font-mono text-xs">
              {item.taskId.slice(0, 16)}
            </span>
            {item.childCount > 0 && (
              <span className="block text-xs text-muted-foreground">
                {t("childCount", { count: item.childCount })}
              </span>
            )}
            {item.error && (
              <span
                className="block max-w-72 truncate text-xs text-destructive"
                title={item.error}
              >
                {item.error}
              </span>
            )}
          </Link>,
          <span key="from" title={item.from.id ?? undefined}>
            {item.from.name}
            <span className="block text-xs text-muted-foreground">
              {t(`directions.${item.direction}`)}
            </span>
          </span>,
          <span key="to" title={item.to.id ?? undefined}>
            {item.to.name}
          </span>,
          <StatusBadge key="state" status={item.state} />,
          <Duration key="duration" ms={item.durationMs} />,
          <RelativeTime key="time" value={item.startedAt} />,
        ],
      }))}
    />
  );
}
