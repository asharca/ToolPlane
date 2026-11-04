"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
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
}: {
  messages: A2AMessageView[];
  artifacts: A2AArtifactView[];
  renderParts?: (parts: JsonValue[], name: string) => ReactNode;
}) {
  const t = useTranslations("console.observability.viewer");
  const parts = (items: JsonValue[], name: string) =>
    renderParts ? renderParts(items, name) : <ContentBlocks blocks={items} />;
  return (
    <>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("messages")}</h2>
        {!messages.length && <EmptyState message={t("noMessages")} />}
        <div className="space-y-4">
          {messages.map((message) => (
            <article
              key={`${message.taskId}:${message.id}`}
              className={`max-w-[95%] space-y-2 rounded-xl border border-border p-4 ${message.role === "user" ? "ml-auto bg-primary/5" : "mr-auto bg-muted/20"}`}
            >
              <header className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {t.has(`roles.${message.role}`)
                    ? t(`roles.${message.role}`)
                    : message.role}
                </span>
                {message.time && <RelativeTime value={message.time} />}
                <a
                  href={`#task-${message.taskId}`}
                  className="font-mono hover:underline"
                >
                  {message.taskId.slice(0, 12)}
                </a>
              </header>
              {parts(message.parts, message.id)}
            </article>
          ))}
        </div>
      </section>
      {artifacts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t("artifacts")}</h2>
          {artifacts.map((artifact) => (
            <article
              key={`${artifact.taskId}:${artifact.id}`}
              className="space-y-3 rounded-lg border border-border p-4"
            >
              <h3 className="text-sm font-medium">
                {artifact.name ?? artifact.id}
              </h3>
              {artifact.description && (
                <p className="text-sm text-muted-foreground">
                  {artifact.description}
                </p>
              )}
              {parts(artifact.parts, artifact.name ?? artifact.id)}
            </article>
          ))}
        </section>
      )}
    </>
  );
}

export function A2ATaskDetail({ detail }: { detail: A2ATaskDetailView }) {
  const t = useTranslations("console.observability.viewer");
  const { summary } = detail;
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
          <p className="text-sm text-destructive">{summary.error}</p>
        )}
      </header>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("taskTree")}</h2>
        <A2ATaskTree nodes={detail.tree} />
      </section>
      <A2ATaskConversation
        messages={detail.messages}
        artifacts={detail.artifacts}
      />
      <Timeline entries={detail.timeline} />
      <details className="space-y-3 rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("rawProtocol")}
        </summary>
        <div className="mt-3 space-y-4">
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
        </div>
      </details>
    </div>
  );
}
