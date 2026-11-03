"use client";
import { Button } from "@/components/motion/button/base";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ConversationExecution } from "../work/ConversationExecution";
import { A2AArtifactParts, type A2AWirePart } from "./A2AArtifactParts";

import type { ConsoleTaskTree } from "@/lib/a2a/console-tasks";
import {
  A2ATaskConversation,
  A2ATaskTree,
  type TaskTreeNode,
} from "@/components/observability/A2ATaskDetail";
import { LiveToggle } from "@/components/observability/LiveToggle";
import { Timeline } from "@/components/observability/Timeline";
import type { JsonValue } from "@/lib/observability/views/types";

type ResultTask = {
  id: string;
  metadata?: {
    toolplaneFileDelivery?: {
      state: "pending" | "failed" | "ready";
      remoteState?: number;
    };
  };
  status?: {
    state?: string;
    message?: { messageId?: string; parts?: A2AWirePart[] };
  };
  history?: Array<{ messageId: string; role: string; parts?: A2AWirePart[] }>;
  artifacts?: Array<{
    artifactId: string;
    name?: string;
    parts?: A2AWirePart[];
  }>;
};
const terminal = (state: string) =>
  [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(state);

/** Read-only task monitoring never resubmits work, even after a network failure. */
export function AgentA2ATaskMonitor({
  base,
  rootTaskId,
  onRootState,
  onUnavailable,
  showHistory = false,
}: {
  base: string;
  rootTaskId: string;
  onRootState: (state: string) => void;
  onUnavailable?: () => void;
  showHistory?: boolean;
}) {
  const t = useTranslations("console.agents.a2a");
  const [tree, setTree] = useState<ConsoleTaskTree | null>(null);
  const [transitions, setTransitions] = useState<ConsoleTaskTree["nodes"]>([]);
  const [selectedId, setSelectedId] = useState(rootTaskId);
  const [automatic, setAutomatic] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [liveAfter] = useState(() => new Date().toISOString());
  const [retryingFiles, setRetryingFiles] = useState(false);
  const [fileRetryFailed, setFileRetryFailed] = useState(false);
  const workspaceMatch = base.match(
    /^\/api\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)\//,
  );
  const streamUrl = workspaceMatch
    ? `/api/v1/workspaces/${workspaceMatch[1]}/logs/stream?kind=a2a&agentId=${workspaceMatch[2]}&after=${encodeURIComponent(liveAfter)}`
    : null;
  const notify = useRef(onRootState);
  const unavailable = useRef(onUnavailable);
  const lastRequest = useRef({ refresh, selectedId });
  useEffect(() => {
    unavailable.current = onUnavailable;
  }, [onUnavailable]);
  useEffect(() => {
    notify.current = onRootState;
  }, [onRootState]);
  useEffect(() => {
    const manual =
      lastRequest.current.refresh !== refresh ||
      lastRequest.current.selectedId !== selectedId;
    lastRequest.current = { refresh, selectedId };
    let stopped = false;
    let flight: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let done = false;
    const load = async () => {
      if (stopped || flight || document.hidden) return;
      const controller = new AbortController();
      flight = controller;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15_000);
      try {
        const query = new URLSearchParams({
          rootTaskId,
          selectedTaskId: selectedId,
        });
        if (showHistory) query.set("historyLength", "32");
        const response = await fetch(`${base}/tasks?${query}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if ([401, 403, 404].includes(response.status)) {
          if (!stopped && !controller.signal.aborted) {
            done = true;
            setTree(null);
            setFailed(true);
            unavailable.current?.();
          }
          return;
        }
        if (!response.ok) throw new Error("Task tree unavailable");
        const value = (await response.json()) as ConsoleTaskTree;
        if (stopped || controller.signal.aborted) return;
        if (value.rootTaskId !== rootTaskId || !Array.isArray(value.nodes))
          throw new Error("Invalid task tree");
        setTree(value);
        setTransitions((previous) => {
          const visible = new Set(value.nodes.map((node) => node.id));
          const snapshots = new Map(
            previous
              .filter((node) => visible.has(node.id))
              .map((node) => [`${node.id}:${node.updatedAt}`, node]),
          );
          for (const node of value.nodes)
            snapshots.set(`${node.id}:${node.updatedAt}`, node);
          return Array.from(snapshots.values())
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            .slice(-500);
        });
        setFailed(false);
        failures = 0;
        const root = value.nodes.find((node) => node.id === rootTaskId);
        if (root) notify.current(root.state);
        done =
          value.nodes.length > 0 &&
          value.nodes.every(
            (node) =>
              node.remoteOutcome !== "unknown" &&
              terminal(node.remoteState ?? node.state),
          );
      } catch {
        if (!stopped && (!controller.signal.aborted || timedOut)) {
          failures++;
          setFailed(true);
        }
      } finally {
        clearTimeout(timeout);
        if (flight === controller) flight = undefined;
        if (
          !stopped &&
          automatic &&
          !done &&
          failures < 3 &&
          !document.hidden
        ) {
          timer = setTimeout(
            () => {
              timer = undefined;
              void load();
            },
            Math.min(20_000, 2500 * 2 ** failures),
          );
        }
      }
    };
    const visibility = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (document.hidden) flight?.abort();
      else if (automatic && !done) {
        failures = 0;
        void load();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    if (automatic || manual) void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      flight?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [base, rootTaskId, selectedId, automatic, refresh, showHistory]);

  const selected = tree?.selectedTask as ResultTask | undefined;
  const nodes: TaskTreeNode[] = (tree?.nodes ?? []).map((node) => ({
    taskId: node.id,
    parentTaskId: node.parentTaskId,
    state:
      node.remoteOutcome === "unknown"
        ? "unknown"
        : (node.remoteState ?? node.state)
            .replace(/^TASK_STATE_/, "")
            .toLowerCase()
            .replaceAll("_", "-"),
    from: {
      kind: node.parentTaskId ? "agent" : "user",
      id: node.parentTaskId,
      name:
        tree?.nodes.find((parent) => parent.id === node.parentTaskId)?.name ??
        t("historyUser"),
    },
    to: { kind: "agent", id: node.agentId, name: node.name },
  }));
  return (
    <section className="space-y-3" aria-label={t("taskTree")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t("taskTree")}</h4>
        <div className="flex gap-2">
          {streamUrl && (
            <LiveToggle
              key={streamUrl}
              url={streamUrl}
              onPausedChange={(paused) => setAutomatic(!paused)}
              onItems={(items) => {
                if (items.length) setRefresh((value) => value + 1);
              }}
            />
          )}
          <Button
            onClick={() => setRefresh((value) => value + 1)}
            variant={"secondary"}
            size={"sm"}
          >
            {t("refreshTasks")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("monitoringHint")}</p>
      {failed ? (
        <div role="alert" className="space-y-2 text-sm text-muted-foreground">
          {t("monitoringFailed")}
        </div>
      ) : null}
      {tree?.restricted ? (
        <div role="alert" className="space-y-2 text-sm text-muted-foreground">
          {t("restrictedTasks")}
        </div>
      ) : null}
      {tree?.nodes.some(
        (node) =>
          node.remoteOutcome === "unknown" ||
          (node.remoteOutcome === "observed" &&
            node.cancelRequested &&
            !terminal(node.remoteState ?? node.state)),
      ) ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("remoteMayContinue")}
        </p>
      ) : null}
      {!tree && !failed ? <p role="status">{t("loading")}</p> : null}
      {tree && (
        <A2ATaskTree
          nodes={nodes}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setFileRetryFailed(false);
            setRefresh((value) => value + 1);
          }}
          renderMetadata={(id) => {
            const node = tree?.nodes.find((item) => item.id === id);
            if (!node) return null;
            return (
              <span className="flex flex-wrap items-center gap-2 text-xs">
                {node.remoteOutcome === "unknown" && (
                  <span>{t("remoteOutcomeUnknown")}</span>
                )}
                {node.authorizedReservation && (
                  <span>
                    {t("authorizedReservation", {
                      currency: node.authorizedReservation.currency,
                      reserved:
                        node.authorizedReservation.reservedMicros / 1_000_000,
                      limit: node.authorizedReservation.limitMicros / 1_000_000,
                    })}
                  </span>
                )}
                <span>
                  {t(
                    node.executionBackend === "pi-harness" &&
                      node.phase === "resumable"
                      ? "phase_recovering"
                      : `phase_${node.phase}`,
                  )}
                </span>
                {node.cancelRequested &&
                  (node.remoteOutcome === "unknown" ? (
                    <span>{t("cancellationUnknown")}</span>
                  ) : !terminal(node.remoteState ?? node.state) ? (
                    <span>{t("cancellationPending")}</span>
                  ) : null)}
              </span>
            );
          }}
        />
      )}
      {tree && (
        <Timeline
          entries={transitions.map((node) => ({
            id: `${node.id}:${node.updatedAt}`,
            taskId: node.id,
            time: node.updatedAt,
            level: node.state === "TASK_STATE_FAILED" ? "error" : "info",
            message: `${node.name} · ${t(node.executionBackend === "pi-harness" && node.phase === "resumable" ? "phase_recovering" : `phase_${node.phase}`)}`,
            state:
              node.remoteOutcome === "unknown"
                ? "unknown"
                : (node.remoteState ?? node.state)
                    .replace(/^TASK_STATE_/, "")
                    .toLowerCase()
                    .replaceAll("_", "-"),
          }))}
        />
      )}
      {selected ? (
        <section
          className="space-y-2 rounded-lg border border-border bg-muted/30 p-3"
          aria-label={t("taskResult")}
        >
          <code className="block break-all text-xs">{selected.id}</code>
          {selected.metadata?.toolplaneFileDelivery?.state === "pending" ? (
            <p role="status" className="text-sm">
              {t("filesReceiving")}
            </p>
          ) : null}
          {selected.metadata?.toolplaneFileDelivery?.state === "failed" ? (
            <div className="space-y-2">
              <p role="status" className="text-sm">
                {t("fileDeliveryFailed")}
              </p>
              <Button
                variant="secondary"
                size="sm"
                disabled={retryingFiles}
                onClick={async () => {
                  setRetryingFiles(true);
                  setFileRetryFailed(false);
                  try {
                    const response = await fetch(`${base}/tasks`, {
                      method: "POST",
                      credentials: "same-origin",
                      cache: "no-store",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "retryFiles",
                        rootTaskId,
                        taskId: selected.id,
                      }),
                      signal: AbortSignal.timeout(15_000),
                    });
                    if (!response.ok) throw new Error("File retry unavailable");
                    setRefresh((value) => value + 1);
                  } catch {
                    setFileRetryFailed(true);
                  } finally {
                    setRetryingFiles(false);
                  }
                }}
              >
                {t("retryFiles")}
              </Button>
              {fileRetryFailed ? (
                <p role="alert" className="text-sm text-destructive">
                  {t("fileRetryFailed")}
                </p>
              ) : null}
            </div>
          ) : null}
          <ConversationExecution
            key={`${rootTaskId}:${selected.id}`}
            endpoint={`${base}/ui?${new URLSearchParams({ rootTaskId, taskId: selected.id })}`}
            showStatus={false}
            active={!terminal(selected.status?.state ?? "")}
          />
          <A2ATaskConversation
            messages={[
              ...(showHistory ? (selected.history ?? []) : []),
              ...(selected.status?.message?.parts?.length &&
              !(
                showHistory &&
                selected.history?.some(
                  (message) =>
                    message.messageId === selected.status?.message?.messageId,
                )
              )
                ? [
                    {
                      messageId:
                        selected.status.message.messageId ??
                        `${selected.id}:status`,
                      role: "ROLE_AGENT",
                      parts: selected.status.message.parts,
                    },
                  ]
                : []),
            ].map((message) => ({
              id: message.messageId,
              taskId: selected.id,
              role: message.role === "ROLE_USER" ? "user" : "agent",
              parts: (message.parts ?? []) as JsonValue[],
              time: null,
            }))}
            artifacts={(selected.artifacts ?? []).map((artifact) => ({
              id: artifact.artifactId,
              taskId: selected.id,
              name: artifact.name ?? null,
              description: null,
              parts: (artifact.parts ?? []) as JsonValue[],
            }))}
            renderParts={(parts, name) => (
              <A2AArtifactParts
                taskId={selected.id}
                name={name}
                parts={parts as A2AWirePart[]}
              />
            )}
          />
        </section>
      ) : null}
    </section>
  );
}
