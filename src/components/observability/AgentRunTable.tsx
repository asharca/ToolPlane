"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
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
}: {
  items: AgentRunSummary[];
  detailBase: string;
  showWorkspace?: boolean;
  returnTo?: string;
}) {
  const t = useTranslations("console.observability.viewer");
  const describeRuntimeError = useRuntimeErrorText();
  if (!items.length) return <EmptyState />;
  return (
    <DashboardTable
      minWidth="56rem"
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
          <Link
            key="agent"
            href={`${detailBase}/${encodeURIComponent(item.taskId)}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
            className="font-medium text-primary hover:underline"
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
          </Link>,
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
