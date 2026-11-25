"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  TraceWaterfall,
  type AgentTraceRun,
  type AgentTraceSpan,
  type TraceWaterfallLabels,
} from "@/components/agents/agent-traces";
import { A2AArtifactParts } from "@/components/dashboard/agents/A2AArtifactParts";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import type { A2AWirePart } from "@/lib/conversation/a2a-parts";
import type { AgentRunDetail as AgentRunDetailView } from "@/lib/observability/views/types";
import { A2ATaskConversation } from "./A2ATaskDetail";
import { A2ATaskTable } from "./A2ATaskTable";
import { McpCallTable } from "./McpCallTable";
import { Duration, RelativeTime, StatusBadge } from "./LogPrimitives";
import { Timeline } from "./Timeline";

function toTraceStatus(state: string): AgentTraceSpan["status"] {
  if (state === "completed" || state === "success") return "completed";
  if (state === "failed" || state === "rejected" || state === "error")
    return "failed";
  if (state === "canceled" || state === "cancelled") return "cancelled";
  return "running";
}

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
  const traceT = useTranslations("console.work.trace");
  const format = useFormatter();
  const describeRuntimeError = useRuntimeErrorText();
  const { summary } = detail;
  const traceLabels = useMemo<Partial<TraceWaterfallLabels>>(
    () => ({
      trace: (name) => traceT("trace", { name }),
      status: {
        completed: traceT("completed"),
        failed: traceT("failed"),
        running: traceT("running"),
        cancelled: traceT("cancelled"),
      },
      retries: (count) => traceT("retries", { count }),
      duration: traceT("duration"),
      spans: traceT("spans"),
      tokens: traceT("tokens"),
      cost: traceT("cost"),
      showKinds: traceT("showKinds"),
      kinds: {
        agent: traceT("kindAgent"),
        llm: traceT("kindLlm"),
        tool: traceT("kindTool"),
        runtime: traceT("kindRuntime"),
      },
      span: traceT("span"),
      expand: (name) => traceT("expand", { name }),
      collapse: (name) => traceT("collapse", { name }),
      expandAll: traceT("expandAll"),
      collapseAll: traceT("collapseAll"),
      search: traceT("search"),
      clearSearch: traceT("clearSearch"),
      errorsOnly: traceT("errorsOnly"),
      zoomIn: traceT("zoomIn"),
      zoomOut: traceT("zoomOut"),
      zoomReset: traceT("zoomReset"),
      previousSpan: traceT("previousSpan"),
      nextSpan: traceT("nextSpan"),
      shareOfTotal: traceT("shareOfTotal"),
      copy: traceT("copy"),
      copied: traceT("copied"),
      expandText: traceT("expandText"),
      collapseText: traceT("collapseText"),
      noSpans: traceT("noSpans"),
      noMatches: traceT("noMatches"),
      resetFilters: traceT("resetFilters"),
      clearSelection: traceT("clearSelection"),
      timing: traceT("timing"),
      start: traceT("start"),
      end: traceT("end"),
      model: traceT("model"),
      inputTokens: traceT("inputTokens"),
      outputTokens: traceT("outputTokens"),
      input: traceT("input"),
      output: traceT("output"),
      notRecorded: traceT("notRecorded"),
      attributes: traceT("attributes"),
      startedAt: (value) =>
        format.dateTime(new Date(value), {
          dateStyle: "medium",
          timeStyle: "medium",
        }),
    }),
    [format, traceT],
  );
  const traceRun = useMemo<AgentTraceRun | null>(() => {
    const hasSpans =
      detail.toolCalls.length > 0 ||
      detail.mcpCalls.length > 0 ||
      detail.delegations.length > 0;
    if (!hasSpans) return null;
    const runStartMs = Date.parse(summary.startedAt);
    if (!Number.isFinite(runStartMs)) return null;
    const rootStatus = toTraceStatus(summary.state);
    const childSpans: AgentTraceSpan[] = [];
    const seenIds = new Set<string>([summary.taskId]);
    for (const call of [...detail.toolCalls, ...detail.mcpCalls]) {
      if (seenIds.has(call.id)) continue;
      seenIds.add(call.id);
      const loggedMs = Date.parse(call.createdAt) - runStartMs;
      const dur = Math.max(1, call.durationMs ?? 1);
      const startMs = Math.max(
        0,
        Number.isFinite(loggedMs)
          ? loggedMs >= dur
            ? loggedMs - dur
            : loggedMs
          : 0,
      );
      childSpans.push({
        id: call.id,
        parentId: summary.taskId,
        name: call.tool ?? call.method ?? t("unknownOperation"),
        kind: "tool",
        startMs,
        durationMs: dur,
        status: toTraceStatus(call.outcome),
        error: call.error ?? undefined,
      });
    }
    for (const del of detail.delegations) {
      if (seenIds.has(del.taskId)) continue;
      seenIds.add(del.taskId);
      const startMs = Math.max(
        0,
        (Date.parse(del.startedAt) || runStartMs) - runStartMs,
      );
      const dur = Math.max(
        1,
        del.durationMs ??
          (del.settledAt
            ? Date.parse(del.settledAt) - Date.parse(del.startedAt)
            : 1),
      );
      childSpans.push({
        id: del.taskId,
        parentId: summary.taskId,
        name: `${del.from.name} → ${del.to.name}`,
        kind: "agent",
        startMs,
        durationMs: dur,
        status: toTraceStatus(del.state),
        error: del.error
          ? (describeRuntimeError(del.error)?.text ?? del.error)
          : undefined,
      });
    }
    childSpans.sort((a, b) => a.startMs - b.startMs);
    const maxSpanEnd = childSpans.reduce(
      (max, span) => Math.max(max, span.startMs + span.durationMs),
      1,
    );
    const totalDuration = Math.max(
      maxSpanEnd,
      summary.durationMs ??
        (summary.settledAt ? Date.parse(summary.settledAt) - runStartMs : 1),
    );
    return {
      id: summary.taskId,
      name: summary.agent?.name ?? t("agent"),
      status: rootStatus,
      startedAt: summary.startedAt,
      durationMs: totalDuration,
      spans: [
        {
          id: summary.taskId,
          name: summary.agent?.name ?? t("agent"),
          kind: "agent",
          startMs: 0,
          durationMs: totalDuration,
          status: rootStatus,
          error: summary.error
            ? (describeRuntimeError(summary.error)?.text ?? summary.error)
            : undefined,
        },
        ...childSpans,
      ],
    };
  }, [
    describeRuntimeError,
    detail.delegations,
    detail.mcpCalls,
    detail.toolCalls,
    summary,
    t,
  ]);
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
  const participantsByTask = new Map<
    string,
    { user?: string; agent?: string }
  >();
  participantsByTask.set(summary.taskId, {
    user: summary.actor.name,
    agent: summary.agent?.name,
  });
  for (const delegation of detail.delegations) {
    participantsByTask.set(delegation.taskId, {
      user: delegation.from.name,
      agent: delegation.to.name,
    });
  }
  const participants = (taskId: string) => participantsByTask.get(taskId);
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
      {traceRun ? <TraceWaterfall run={traceRun} labels={traceLabels} /> : null}
      <A2ATaskConversation
        messages={detail.messages}
        artifacts={detail.artifacts}
        participants={participants}
        renderParts={(parts, name, taskId) => (
          <A2AArtifactParts
            taskId={taskId}
            name={name}
            parts={parts as A2AWirePart[]}
            producer={participants(taskId)?.agent}
          />
        )}
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
