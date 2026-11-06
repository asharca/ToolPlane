"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { DashboardTable } from "@/components/dashboard/DashboardUI";
import type { McpCallSummary } from "@/lib/observability/views/types";
import {
  Duration,
  EmptyState,
  RelativeTime,
  StatusBadge,
} from "./LogPrimitives";

export function McpCallTable({
  items,
  detailBase,
  runDetailBase,
  a2aDetailBase,
  showWorkspace = false,
  returnTo,
}: {
  items: McpCallSummary[];
  detailBase: string;
  runDetailBase: string;
  a2aDetailBase: string;
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
        { label: t("operation") },
        { label: t("server") },
        { label: t("caller") },
        { label: t("task") },
        { label: t("status") },
        { label: t("duration") },
        { label: t("time") },
      ]}
      rows={items.map((item) => ({
        id: item.id,
        cells: [
          ...(showWorkspace ? [item.workspace?.name ?? "—"] : []),
          <Link
            key="operation"
            className="font-medium text-primary hover:underline"
            href={`${detailBase}/${encodeURIComponent(item.id)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
          >
            <span>{item.tool ?? item.method ?? t("unknownOperation")}</span>
            {item.tool && (
              <span className="block text-xs text-muted-foreground">
                {item.method}
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
          <span key="server" title={item.deployment?.id}>
            {item.deployment?.name ?? item.server?.name ?? "—"}
          </span>,
          <span key="caller" title={item.caller.id ?? undefined}>
            {item.caller.kind === "unknown" ? (
              t("unknownCaller")
            ) : (
              <>
                {item.caller.name}
                <span className="block text-xs text-muted-foreground">
                  {t(`parties.${item.caller.kind}`)}
                </span>
              </>
            )}
          </span>,
          item.task ? (
            <Link
              key="task"
              href={`${item.task.kind === "run" ? runDetailBase : a2aDetailBase}/${encodeURIComponent(item.task.id)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
              className="text-xs text-primary hover:underline"
            >
              {t(item.task.kind === "run" ? "run" : "task")} ·{" "}
              {item.task.id.slice(0, 12)}
            </Link>
          ) : (
            "—"
          ),
          <StatusBadge key="status" status={item.outcome} />,
          <Duration key="duration" ms={item.durationMs} />,
          <RelativeTime key="time" value={item.createdAt} />,
        ],
      }))}
    />
  );
}
