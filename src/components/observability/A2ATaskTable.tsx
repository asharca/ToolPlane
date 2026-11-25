"use client";

import Link from "next/link";
import { PanelRightOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
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
  runDetailBase,
  showWorkspace = false,
  returnTo,
  onInspect,
}: {
  items: A2ATaskSummary[];
  detailBase: string;
  runDetailBase: string;
  showWorkspace?: boolean;
  returnTo?: string;
  onInspect?: (id: string) => void;
}) {
  const t = useTranslations("console.observability.viewer");
  const common = useTranslations("common");
  const describeRuntimeError = useRuntimeErrorText();
  if (!items.length) return <EmptyState />;
  return (
    <DashboardTable
      minWidth="48rem"
      adjustableColumns={false}
      headers={[
        ...(showWorkspace ? [{ label: t("workspace") }] : []),
        { label: t("task") },
        { label: t("from") },
        { label: t("to") },
        { label: t("originRun") },
        { label: t("status") },
        { label: t("duration") },
        { label: t("time") },
      ]}
      rows={items.map((item) => ({
        id: item.taskId,
        cells: [
          ...(showWorkspace ? [item.workspace?.name ?? "—"] : []),
          <div key="task" className="flex items-start justify-between gap-2">
            <Link
              href={`${detailBase}/${encodeURIComponent(item.taskId)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
              className="min-w-0 font-medium text-primary hover:underline"
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
                  title={describeRuntimeError(item.error)?.text ?? item.error}
                >
                  {describeRuntimeError(item.error)?.text ?? item.error}
                </span>
              )}
            </Link>
            {onInspect ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                title={common("preview")}
                aria-label={common("preview")}
                onClick={() => onInspect(item.taskId)}
              >
                <PanelRightOpen className="size-3.5" />
              </Button>
            ) : null}
          </div>,
          <span key="from" title={item.from.id ?? undefined}>
            {item.from.name}
            <span className="block text-xs text-muted-foreground">
              {t(`directions.${item.direction}`)}
            </span>
          </span>,
          <span key="to" title={item.to.id ?? undefined}>
            {item.to.name}
          </span>,
          item.origin ? (
            <Link
              key="origin"
              href={`${runDetailBase}/${encodeURIComponent(item.origin.runTaskId)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
              className="text-xs text-primary hover:underline"
            >
              {item.origin.agent?.name ?? t("agent")} ·{" "}
              {t(`entryKinds.${item.origin.entryKind}`)}
            </Link>
          ) : (
            "—"
          ),
          <StatusBadge key="state" status={item.state} />,
          <Duration key="duration" ms={item.durationMs} />,
          <RelativeTime key="time" value={item.startedAt} />,
        ],
      }))}
    />
  );
}
