"use client";

import Link from "next/link";
import { PanelRightOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { DashboardTable } from "@/components/dashboard/DashboardUI";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import type { AgentRunSummary } from "@/lib/observability/views/types";
import {
  Duration,
  EmptyState,
  RelativeTime,
  StatusBadge,
} from "./LogPrimitives";

export function AgentRunTable({
  items,
  detailBase,
  showWorkspace = false,
  returnTo,
  onInspect,
}: {
  items: AgentRunSummary[];
  detailBase: string;
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
      minWidth="56rem"
      adjustableColumns={false}
      headers={[
        ...(showWorkspace ? [{ label: t("workspace") }] : []),
        { label: t("agent") },
        { label: t("source") },
        { label: t("actor") },
        { label: t("status") },
        { label: t("toolCallsAndDelegations") },
        { label: t("duration") },
        { label: t("time") },
      ]}
      rows={items.map((item) => ({
        id: item.taskId,
        cells: [
          ...(showWorkspace ? [item.workspace?.name ?? "—"] : []),
          <div key="agent" className="flex items-start justify-between gap-2">
            <Link
              href={`${detailBase}/${encodeURIComponent(item.taskId)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
              className="min-w-0 font-medium text-primary hover:underline"
            >
              {item.agent?.name ?? t("agent")}
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
          <span key="source">
            {t(`entryKinds.${item.entryKind}`)}
            {item.source && (
              <span
                className="block max-w-64 truncate text-xs text-muted-foreground"
                title={item.source.title ?? item.source.id}
              >
                {item.source.title ?? item.source.id}
              </span>
            )}
          </span>,
          item.actor.name,
          <StatusBadge key="state" status={item.state} />,
          `${item.toolCallCount} / ${item.delegationCount}`,
          <Duration key="duration" ms={item.durationMs} />,
          <RelativeTime key="time" value={item.startedAt} />,
        ],
      }))}
    />
  );
}
