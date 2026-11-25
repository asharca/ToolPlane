"use client";

import { useMemo, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  TraceWaterfall,
  type AgentTraceRun,
  type AgentTraceSpan,
  type TraceWaterfallLabels,
} from "@/components/agents/agent-traces";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/motion/collapsible";
import { A2AArtifactParts } from "@/components/dashboard/agents/A2AArtifactParts";
import { useRuntimeErrorText } from "@/components/dashboard/useRuntimeErrorText";
import type { A2AWirePart } from "@/lib/conversation/a2a-parts";
import type {
  A2ATaskDetail as A2ATaskDetailView,
  A2ATaskNode,
  A2AMessageView,
  A2AArtifactView,
  JsonValue,
} from "@/lib/observability/views/types";
import {
  Duration,
  EmptyState,
  RelativeTime,
  StatusBadge,
} from "./LogPrimitives";
import { BodyNotice, ContentBlocks, JsonPanel } from "./ProtocolContent";
import { Timeline } from "./Timeline";

export type TaskTreeNode = Pick<
  A2ATaskNode,
  "taskId" | "parentTaskId" | "from" | "to" | "state"
>;

export function A2ATaskTree({
  nodes,
  selectedId,
  onSelect,
  renderMetadata,
}: {
  nodes: TaskTreeNode[];
  selectedId?: string;
  onSelect?: (taskId: string) => void;
  renderMetadata?: (taskId: string) => ReactNode;
}) {
  const t = useTranslations("console.observability.viewer");
  const ids = new Set(nodes.map((node) => node.taskId));
  const children = new Map<string, TaskTreeNode[]>();
  for (const node of nodes) {
    const parent =
      node.parentTaskId && ids.has(node.parentTaskId) ? node.parentTaskId : "";
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  function renderTree(parent: string, visited: Set<string>): ReactNode {
    return (
      <ul className="space-y-2 border-l border-border pl-4">
        {(children.get(parent) ?? [])
          .filter((node) => !visited.has(node.taskId))
          .map((node) => (
            <li
              key={node.taskId}
              id={`task-${node.taskId}`}
              className="space-y-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(node.taskId)}
                    aria-pressed={selectedId === node.taskId}
                    className="rounded-md px-2 py-1 text-left hover:bg-muted aria-pressed:bg-muted"
                  >
                    <span>
                      {node.from.name} → {node.to.name}
                    </span>
                    <code className="block break-all text-xs text-muted-foreground">
                      {node.taskId}
                    </code>
                  </button>
                ) : (
                  <>
                    <span>
                      {node.from.name} → {node.to.name}
                    </span>
                    <code className="break-all text-xs text-muted-foreground">
                      {node.taskId}
                    </code>
                  </>
                )}
                <StatusBadge status={node.state} />
                {renderMetadata?.(node.taskId)}
              </div>
              {children.has(node.taskId) &&
                renderTree(node.taskId, new Set([...visited, node.taskId]))}
            </li>
          ))}
      </ul>
    );
  }
  return nodes.length ? (
    renderTree("", new Set())
  ) : (
    <EmptyState message={t("logOnly")} />
  );
}

export function A2ATaskConversation({
  messages,
  artifacts,
  renderParts,
  participants,
}: {
  messages: A2AMessageView[];
  artifacts: A2AArtifactView[];
  renderParts?: (parts: JsonValue[], name: string, taskId: string) => ReactNode;
  participants?: (
    taskId: string,
  ) => { user?: string; agent?: string } | undefined;
}) {
  const t = useTranslations("console.observability.viewer");
  const parts = (items: JsonValue[], name: string, taskId: string) =>
    renderParts ? (
      renderParts(items, name, taskId)
    ) : (
      <ContentBlocks blocks={items} />
    );
  return (
    <>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("messages")}</h2>
        {!messages.length && <EmptyState message={t("noMessages")} />}
        <div className="space-y-4">
          {messages.map((message) => {
            const party = participants?.(message.taskId);
            const roleLabel =
              message.role === "user"
                ? party?.user
                : message.role === "agent"
                  ? party?.agent
                  : undefined;
            return (
              <article
                key={`${message.taskId}:${message.id}`}
                className={`max-w-[95%] space-y-2 rounded-xl border border-border p-4 ${message.role === "user" ? "ml-auto bg-primary/5" : "mr-auto bg-muted/20"}`}
              >
                <header className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {roleLabel ||
                      (t.has(`roles.${message.role}`)
                        ? t(`roles.${message.role}`)
                        : message.role)}
                  </span>
                  {message.time && <RelativeTime value={message.time} />}
                  <a
                    href={`#task-${message.taskId}`}
                    className="font-mono hover:underline"
                  >
                    {message.taskId.slice(0, 12)}
                  </a>
                </header>
                {parts(message.parts, message.id, message.taskId)}
              </article>
            );
          })}
        </div>
      </section>
      {artifacts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t("artifacts")}</h2>
          {artifacts.map((artifact) => {
            const producer = participants?.(artifact.taskId)?.agent;
            return (
              <article
                key={`${artifact.taskId}:${artifact.id}`}
                className="space-y-3 rounded-lg border border-border p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {artifact.name ?? artifact.id}
                  </h3>
                  {producer && (
                    <span className="text-xs text-muted-foreground">
                      {t("producedBy", { name: producer })}
                    </span>
                  )}
                </div>
                {artifact.description && (
                  <p className="text-sm text-muted-foreground">
                    {artifact.description}
                  </p>
                )}
                {parts(
                  artifact.parts,
                  artifact.name ?? artifact.id,
                  artifact.taskId,
                )}
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}

export function A2ATaskDetail({ detail }: { detail: A2ATaskDetailView }) {
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
    if (detail.tree.length <= 1) return null;
    const toStatus = (state: string): AgentTraceSpan["status"] => {
      if (state === "completed") return "completed";
      if (state === "failed" || state === "rejected") return "failed";
      if (state === "canceled") return "cancelled";
      return "running";
    };
    const starts = detail.tree
      .map((node) => Date.parse(node.startedAt))
      .filter((ms) => Number.isFinite(ms));
    const rootStartMs = starts.length
      ? Math.min(...starts)
      : Date.parse(summary.startedAt);
    if (!Number.isFinite(rootStartMs)) return null;
    const nodeIds = new Set(detail.tree.map((node) => node.taskId));
    const spans: AgentTraceSpan[] = detail.tree.map((node) => {
      const nodeStart = Date.parse(node.startedAt);
      const startMs = Math.max(
        0,
        (Number.isFinite(nodeStart) ? nodeStart : rootStartMs) - rootStartMs,
      );
      const nodeEnd = node.settledAt ? Date.parse(node.settledAt) : Number.NaN;
      const durationMs = Math.max(
        1,
        Number.isFinite(nodeEnd) && Number.isFinite(nodeStart)
          ? nodeEnd - nodeStart
          : node.taskId === summary.taskId
            ? (summary.durationMs ?? 1)
            : 1,
      );
      return {
        id: node.taskId,
        parentId:
          node.parentTaskId && nodeIds.has(node.parentTaskId)
            ? node.parentTaskId
            : undefined,
        name: `${node.from.name} → ${node.to.name}`,
        kind: "agent",
        startMs,
        durationMs,
        status: toStatus(node.state),
      };
    });
    const totalDuration = Math.max(
      summary.durationMs ?? 1,
      ...spans.map((span) => span.startMs + span.durationMs),
    );
    return {
      id: summary.taskId,
      name: `${summary.from.name} → ${summary.to.name}`,
      status: toStatus(summary.state),
      startedAt: summary.startedAt,
      durationMs: totalDuration,
      spans,
    };
  }, [detail.tree, summary]);
  const participantsByTask = new Map<
    string,
    { user?: string; agent?: string }
  >();
  for (const node of detail.tree) {
    participantsByTask.set(node.taskId, {
      user: node.from.name,
      agent: node.to.name,
    });
  }
  if (!participantsByTask.has(summary.taskId)) {
    participantsByTask.set(summary.taskId, {
      user: summary.from.name,
      agent: summary.to.name,
    });
  }
  const participants = (taskId: string) => participantsByTask.get(taskId);
  return (
    <div className="min-w-0 space-y-6">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold">
          {summary.from.name} → {summary.to.name}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={summary.state} />
          <Duration ms={summary.durationMs} />
          <RelativeTime value={summary.startedAt} />
          {summary.settledAt && (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("settledAt")}
              <RelativeTime value={summary.settledAt} />
            </span>
          )}
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {t("task")}: {summary.taskId}
        </p>
        {summary.contextId && (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {t("context")}: {summary.contextId}
          </p>
        )}
        {summary.error && (
          <p className="text-sm text-destructive">
            {describeRuntimeError(summary.error)?.text ?? summary.error}
          </p>
        )}
      </header>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("taskTree")}</h2>
        {traceRun ? (
          <TraceWaterfall run={traceRun} labels={traceLabels} />
        ) : null}
        <A2ATaskTree nodes={detail.tree} />
      </section>
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
      <Timeline entries={detail.timeline} />
      <Collapsible className="rounded-lg border border-border px-4 py-3">
        <CollapsibleTrigger className="px-0 py-1 text-sm font-medium">
          {t("rawProtocol")}
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          {detail.protocol.map((event) => (
            <section key={event.eventId} className="space-y-3">
              <p className="break-all font-mono text-xs text-muted-foreground">
                {event.source === "ledger" ? t("ledgerSource") : t("logSource")}
                {" · "}
                {event.eventId}
              </p>
              <BodyNotice state={event.bodyState} />
              <div className="grid min-w-0 gap-3 xl:grid-cols-2">
                {event.request !== undefined && (
                  <JsonPanel
                    title={t(
                      event.source === "ledger" ? "ledgerRequest" : "request",
                    )}
                    value={event.request}
                  />
                )}
                {event.response !== undefined && (
                  <JsonPanel
                    title={t(
                      event.source === "ledger" ? "ledgerResponse" : "response",
                    )}
                    value={event.response}
                  />
                )}
              </div>
            </section>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
