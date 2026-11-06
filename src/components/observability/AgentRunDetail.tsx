"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import type { AgentRunDetail as AgentRunDetailView } from "@/lib/observability/views/types";
import { A2ATaskConversation } from "./A2ATaskDetail";
import { A2ATaskTable } from "./A2ATaskTable";
import { McpCallTable } from "./McpCallTable";
import { Duration, RelativeTime, StatusBadge } from "./LogPrimitives";
import { Timeline } from "./Timeline";

export function AgentRunDetail({
  detail,
  base,
  workspaceSlug,
}: {
  detail: AgentRunDetailView;
  base: string;
  workspaceSlug?: string;
}) {
  const t = useTranslations("console.observability.viewer");
  const describeRuntimeError = useRuntimeErrorText();
  const { summary } = detail;
  const source = summary.source;
  const workspaceBase = workspaceSlug
    ? `/app/${encodeURIComponent(workspaceSlug)}`
    : null;
  const sourceHref =
    workspaceBase && source
      ? source.kind === "work"
        ? `${workspaceBase}/work?w=${encodeURIComponent(source.id)}`
        : summary.agent
          ? `${workspaceBase}/agents/${encodeURIComponent(summary.agent.id)}?c=${encodeURIComponent(source.id)}`
          : null
      : null;
  const callProps = {
    detailBase: `${base}/mcp`,
    runDetailBase: `${base}/runs`,
    a2aDetailBase: `${base}/a2a`,
    returnTo: `${base}/runs/${encodeURIComponent(summary.taskId)}`,
  };
  return (
    <div className="min-w-0 space-y-6">
      <header id={`task-${summary.taskId}`} className="space-y-3">
        <h1 className="text-xl font-semibold">
          {summary.agent?.name ?? t("agent")}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={summary.state} />
          <Duration ms={summary.durationMs} />
          <RelativeTime value={summary.startedAt} />
          {summary.settledAt && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("settledAt")} <RelativeTime value={summary.settledAt} />
            </span>
          )}
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t("source")}</dt>
            <dd>
              {t(`entryKinds.${summary.entryKind}`)}
              {source && (
                <>
                  {" "}
                  ·{" "}
                  {sourceHref ? (
                    <Link
                      className="text-primary hover:underline"
                      href={sourceHref}
                    >
                      {source.title ?? source.id}
                    </Link>
                  ) : (
                    (source.title ?? source.id)
                  )}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("actor")}</dt>
            <dd>{summary.actor.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t("toolCallsAndDelegations")}
            </dt>
            <dd>
              {summary.toolCallCount} / {summary.delegationCount}
            </dd>
          </div>
        </dl>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {t("run")}: {summary.taskId}
        </p>
        {summary.error && (
          <p className="text-sm text-destructive">
            {describeRuntimeError(summary.error)?.text ?? summary.error}
          </p>
        )}
      </header>
      <A2ATaskConversation
        messages={detail.messages}
        artifacts={detail.artifacts}
      />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("tools")}</h2>
        <McpCallTable items={detail.toolCalls} {...callProps} />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("mcp")}</h2>
        <McpCallTable items={detail.mcpCalls} {...callProps} />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("delegations")}</h2>
        <A2ATaskTable
          items={detail.delegations}
          detailBase={`${base}/a2a`}
          runDetailBase={`${base}/runs`}
          returnTo={`${base}/runs/${encodeURIComponent(summary.taskId)}`}
        />
      </section>
      <Timeline entries={detail.timeline} />
    </div>
  );
}
