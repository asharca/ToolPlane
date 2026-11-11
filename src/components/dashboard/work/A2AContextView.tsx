"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button/base";
import { MessageScroller } from "@/components/agents/message-scroller";
import {
  A2AArtifactParts,
  type A2AWirePart,
} from "@/components/dashboard/agents/A2AArtifactParts";
import {
  A2ATaskConversation,
  A2ATaskTree,
  type TaskTreeNode,
} from "@/components/observability/A2ATaskDetail";
import { StatusBadge } from "@/components/observability/LogPrimitives";
import type { ConsoleTaskTree } from "@/lib/a2a/console-tasks";
import type { JsonValue } from "@/lib/observability/views/types";
import { LiveOutputStatus, LiveOutputView } from "./LiveOutputView";
import { useLiveTaskOutput } from "./useLiveTaskOutput";

export type A2AContextSummary = {
  contextId: string;
  peer: { kind: "agent" | "remote" | "client"; name: string };
  title: string;
  state: string;
  updatedAt: string;
  tasks: Array<{
    taskId: string;
    rootTaskId: string;
    rootAgentId: string;
    createdAt: string;
  }>;
};

export type A2AContextPage = {
  items: A2AContextSummary[];
  nextCursor: string | null;
};

type ContextList = A2AContextPage & {
  loading: boolean;
  failed: boolean;
  expanded: boolean;
};

type ContextSelection = {
  key: string;
  context: A2AContextSummary | null;
  status: "ready" | "missing" | "failed";
};

/** Resource identities, not translated labels or refreshed server props, own requests. */
export function useA2AContexts(
  slug: string,
  agentIds: string[],
  selectedAgentId?: string,
  selectedTaskId?: string,
) {
  const agentKey = JSON.stringify([...new Set(agentIds)].sort());
  const [lists, setLists] = useState<Record<string, ContextList>>({});
  const [selection, setSelection] = useState<ContextSelection | null>(null);
  const [selectionRefresh, setSelectionRefresh] = useState(0);
  const requests = useRef(new Map<string, AbortController>());
  const selectionKey = selectedTaskId
    ? `${slug}:${selectedAgentId ?? ""}:${selectedTaskId}`
    : "";
  const load = useCallback(
    async (agentId: string, cursor?: string) => {
      const key = `${slug}:${agentId}`;
      if (requests.current.has(key)) return;
      const controller = new AbortController();
      requests.current.set(key, controller);
      setLists((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? {
            items: [],
            nextCursor: null,
            failed: false,
            expanded: false,
          }),
          loading: true,
        },
      }));
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const query = new URLSearchParams(cursor ? { cursor } : {});
        const response = await fetch(
          `${a2aConsoleBase(slug, agentId)}/contexts?${query}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) {
          setLists((current) => ({
            ...current,
            [key]: {
              items: [],
              nextCursor: null,
              loading: false,
              failed: true,
              expanded: false,
            },
          }));
          return;
        }
        if (!response.ok) throw new Error("Contexts unavailable");
        const page = (await response.json()) as A2AContextPage;
        if (controller.signal.aborted) return;
        if (!Array.isArray(page.items)) throw new Error("Invalid contexts");
        setLists((current) => {
          const previous = current[key];
          const keepOlder = Boolean(cursor || previous?.expanded);
          const items = new Map(
            (keepOlder ? (previous?.items ?? []) : []).map((item) => [
              item.contextId,
              item,
            ]),
          );
          for (const item of page.items) items.set(item.contextId, item);
          return {
            ...current,
            [key]: {
              items: [...items.values()].sort((a, b) =>
                b.updatedAt.localeCompare(a.updatedAt),
              ),
              nextCursor:
                !cursor && previous?.expanded
                  ? previous.nextCursor
                  : page.nextCursor,
              expanded: Boolean(cursor || previous?.expanded),
              failed: false,
              loading: false,
            },
          };
        });
      } catch {
        if (requests.current.get(key) === controller) {
          setLists((current) => ({
            ...current,
            [key]: {
              ...(current[key] ?? {
                items: [],
                nextCursor: null,
                expanded: false,
              }),
              loading: false,
              failed: true,
            },
          }));
        }
      } finally {
        clearTimeout(timeout);
        if (requests.current.get(key) === controller)
          requests.current.delete(key);
      }
    },
    [slug],
  );

  useEffect(() => {
    const ids = JSON.parse(agentKey) as string[];
    const refresh = () => {
      if (!document.hidden) for (const id of ids) void load(id);
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [agentKey, load]);

  useEffect(() => {
    const pending = requests.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry action must reload the selected context even when its identity is unchanged.
  useEffect(() => {
    if (!selectedTaskId || !selectedAgentId) return;
    let stopped = false;
    let flight: AbortController | undefined;
    const loadSelection = async () => {
      if (stopped || flight || document.hidden) return;
      const controller = new AbortController();
      flight = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const query = new URLSearchParams({ taskId: selectedTaskId });
        const response = await fetch(
          `${a2aConsoleBase(slug, selectedAgentId)}/contexts?${query}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (stopped) return;
        if ([401, 403, 404].includes(response.status)) {
          setSelection({ key: selectionKey, context: null, status: "missing" });
          return;
        }
        if (!response.ok) throw new Error("Context unavailable");
        const page = (await response.json()) as A2AContextPage;
        if (!Array.isArray(page.items)) throw new Error("Invalid contexts");
        if (!stopped)
          setSelection({
            key: selectionKey,
            context: page.items[0] ?? null,
            status: page.items.length ? "ready" : "missing",
          });
      } catch {
        if (!stopped)
          setSelection((current) => ({
            key: selectionKey,
            context: current?.key === selectionKey ? current.context : null,
            status: "failed",
          }));
      } finally {
        clearTimeout(timeout);
        if (flight === controller) flight = undefined;
      }
    };
    void loadSelection();
    const timer = window.setInterval(() => void loadSelection(), 15_000);
    const visibility = () => {
      if (document.hidden) flight?.abort();
      else void loadSelection();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      clearInterval(timer);
      flight?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [slug, selectedAgentId, selectedTaskId, selectionKey, selectionRefresh]);

  const selected = selection?.key === selectionKey ? selection : null;
  const pages = Object.fromEntries(
    agentIds.map((id) => [id, lists[`${slug}:${id}`]]),
  );
  const listedContext = pages[selectedAgentId ?? ""]?.items.find(
    (item) => item.contextId === selected?.context?.contextId,
  );
  const context =
    selected?.context &&
    listedContext &&
    listedContext.updatedAt > selected.context.updatedAt
      ? listedContext
      : (selected?.context ?? null);
  return {
    pages,
    context,
    selectionStatus: !selectedAgentId
      ? "missing"
      : (selected?.status ?? "loading"),
    loadMore: (agentId: string) => {
      const cursor = lists[`${slug}:${agentId}`]?.nextCursor;
      if (cursor) void load(agentId, cursor);
    },
    refreshSelection: () => setSelectionRefresh((value) => value + 1),
  };
}

export function a2aConsoleBase(slug: string, agentId: string) {
  return `/api/v1/workspaces/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}/a2a/console`;
}

export function a2aStateKey(state: string) {
  const key = state
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replaceAll("_", "-");
  return key === "unspecified" ? "unknown" : key;
}

function terminal(state: string) {
  return [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(state);
}

type ResultTask = {
  id: string;
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
  metadata?: {
    toolplaneFileDelivery?: { state: "pending" | "failed" | "ready" };
  };
};

function A2AContextTask({
  slug,
  task,
  index,
  latest,
  initialState,
  onState,
  onUnavailable,
}: {
  slug: string;
  task: A2AContextSummary["tasks"][number];
  index: number;
  latest: boolean;
  initialState: string;
  onState: (state: string) => void;
  onUnavailable: () => void;
}) {
  const t = useTranslations("console.work.a2a");
  const a2a = useTranslations("console.agents.a2a");
  const work = useTranslations("console.work");
  const base = a2aConsoleBase(slug, task.rootAgentId);
  const { rootTaskId, taskId } = task;
  const [tree, setTree] = useState<ConsoleTaskTree | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Follow running output; completed and older tasks load their durable replay
  // with the task tree without opening another long-lived stream.
  const [watchOutput, setWatchOutput] = useState(
    latest && !terminal(initialState),
  );
  if (latest && !terminal(initialState) && !watchOutput) setWatchOutput(true);
  const notifyState = useEffectEvent(onState);
  const unavailable = useEffectEvent(onUnavailable);
  const live = useLiveTaskOutput({
    url:
      latest && watchOutput
        ? `${base}/tasks/events?${new URLSearchParams({ rootTaskId, selectedTaskId: taskId })}`
        : null,
    onSettled: (settledId) => {
      if (settledId === taskId) setRefresh((value) => value + 1);
    },
    onRevoked: () => {
      setTree(null);
      unavailable();
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Settlement bumps refresh to reload the final task snapshot.
  useEffect(() => {
    let stopped = false;
    let flight: AbortController | undefined;
    let timer: number | undefined;
    let failures = 0;
    let done = false;
    const load = async () => {
      if (stopped || flight || document.hidden) return;
      const controller = new AbortController();
      flight = controller;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15_000);
      try {
        const query = new URLSearchParams({
          rootTaskId,
          selectedTaskId: taskId,
          historyLength: "32",
        });
        const response = await fetch(`${base}/tasks?${query}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (stopped || controller.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) {
          done = true;
          setTree(null);
          unavailable();
          return;
        }
        if (!response.ok) throw new Error("Task unavailable");
        const value = (await response.json()) as ConsoleTaskTree;
        if (stopped || controller.signal.aborted) return;
        if (
          value.rootTaskId !== rootTaskId ||
          value.selectedTask?.id !== taskId ||
          !Array.isArray(value.nodes)
        )
          throw new Error("Invalid task tree");
        setTree(value);
        setFailed(false);
        failures = 0;
        const selected = value.nodes.find((node) => node.id === taskId);
        if (latest && selected) notifyState(selected.state);
        done = value.nodes.every(
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
        if (!stopped && latest && !done && failures < 3 && !document.hidden)
          timer = window.setTimeout(
            () => void load(),
            Math.min(30_000, 5_000 * 2 ** failures),
          );
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      timer = undefined;
      if (document.hidden) flight?.abort();
      else if (!done) {
        failures = 0;
        void load();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
      flight?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [base, rootTaskId, taskId, latest, refresh]);

  const selected = tree?.selectedTask as ResultTask | undefined;
  const output =
    live.output?.taskId === taskId
      ? live.output
      : (tree?.selectedOutput ?? null);
  const outputText = output?.text.replace(/\s+/g, " ").trim();
  const persistedParts = selected
    ? [
        ...(selected.history ?? []).filter(
          (message) => message.role !== "ROLE_USER",
        ),
        ...(selected.status?.message ? [selected.status.message] : []),
        ...(selected.artifacts ?? []),
        {
          parts: (selected.artifacts ?? []).flatMap(
            (artifact) => artifact.parts ?? [],
          ),
        },
      ]
    : [];
  const outputTextPersisted =
    !output?.text ||
    persistedParts.some((item) => {
      const texts = (item.parts ?? []).flatMap((part) =>
        typeof part.text === "string" ? [part.text] : [],
      );
      return [texts.join("\n"), texts.join("")].some((text) => {
        const persisted = text.replace(/\s+/g, " ").trim();
        return (
          persisted === outputText ||
          (!output.active &&
            Boolean(outputText) &&
            persisted.startsWith(outputText ?? ""))
        );
      });
    });
  const nodes: TaskTreeNode[] = (tree?.nodes ?? []).map((node) => ({
    taskId: node.id,
    parentTaskId: node.parentTaskId,
    state:
      node.remoteOutcome === "unknown"
        ? "unknown"
        : a2aStateKey(node.remoteState ?? node.state),
    from: {
      kind: node.parentTaskId ? "agent" : "user",
      id: node.parentTaskId,
      name:
        tree?.nodes.find((parent) => parent.id === node.parentTaskId)?.name ??
        a2a("historyUser"),
    },
    to: { kind: "agent", id: node.agentId, name: node.name },
  }));

  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={t("task", { number: index + 1 })}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {t("task", { number: index + 1 })}
          </h3>
          <code className="block break-all text-xs text-muted-foreground">
            {taskId}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selected?.status?.state ? (
            <StatusBadge status={a2aStateKey(selected.status.state)} />
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRefresh((value) => value + 1)}
          >
            {work("executionRefresh")}
          </Button>
        </div>
      </header>
      {latest && watchOutput ? (
        <LiveOutputStatus connection={live.connection} />
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {a2a("monitoringFailed")}
        </p>
      ) : null}
      {!tree && !failed ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : null}
      {tree ? (
        <>
          <details className="min-w-0 rounded-xl border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {a2a("taskTree")}
            </summary>
            <div className="mt-3 overflow-x-auto">
              <A2ATaskTree nodes={nodes} selectedId={taskId} />
            </div>
          </details>
          {tree.restricted ? (
            <p role="status" className="text-sm text-muted-foreground">
              {a2a("restrictedTasks")}
            </p>
          ) : null}
          {selected?.metadata?.toolplaneFileDelivery?.state === "pending" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {a2a("filesReceiving")}
            </p>
          ) : null}
          {selected?.metadata?.toolplaneFileDelivery?.state === "failed" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {a2a("fileDeliveryFailed")}
            </p>
          ) : null}
        </>
      ) : null}
      {selected ? (
        <A2ATaskConversation
          messages={[
            ...(selected.history ?? []),
            ...(selected.status?.message?.parts?.length &&
            !selected.history?.some(
              (message) =>
                message.messageId === selected.status?.message?.messageId,
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
      ) : null}
      {output &&
      (!outputTextPersisted ||
        output.activities.length > 0 ||
        output.active) ? (
        <div className="min-w-0 rounded-xl border border-border bg-muted/20 p-3">
          <LiveOutputView output={output} hideText={outputTextPersisted} />
        </div>
      ) : null}
    </section>
  );
}

/** A2A ledger contexts stay separate from chat Conversations and never get a composer. */
export function A2AContextView({
  slug,
  context,
}: {
  slug: string;
  context: A2AContextSummary;
}) {
  const t = useTranslations("console.work.a2a");
  const [unavailable, setUnavailable] = useState(false);
  const latestTaskId = context.tasks.at(-1)?.taskId;
  const [observedState, setObservedState] = useState({
    taskId: latestTaskId,
    sourceUpdatedAt: context.updatedAt,
    state: context.state,
  });
  const state =
    observedState.taskId === latestTaskId &&
    observedState.sourceUpdatedAt === context.updatedAt
      ? observedState.state
      : context.state;
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={t("title")}
    >
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-base font-semibold">
            {context.peer.name}
          </h2>
          {context.title ? (
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {context.title}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">{t("readOnly")}</p>
        </div>
        <StatusBadge status={a2aStateKey(state)} />
      </header>
      {unavailable ? (
        <p
          role="alert"
          className="px-4 py-6 text-sm text-muted-foreground sm:px-6"
        >
          {t("unavailable")}
        </p>
      ) : (
        <MessageScroller
          label={t("title")}
          className="min-h-0 flex-1"
          contentClassName="mx-auto w-full max-w-3xl space-y-8 px-4 pb-8 sm:px-6"
        >
          {context.tasks.map((task, index) => (
            <A2AContextTask
              key={`${task.rootTaskId}:${task.taskId}`}
              slug={slug}
              task={task}
              index={index}
              latest={task.taskId === latestTaskId}
              initialState={context.state}
              onState={(next) =>
                setObservedState({
                  taskId: latestTaskId,
                  sourceUpdatedAt: context.updatedAt,
                  state: next,
                })
              }
              onUnavailable={() => setUnavailable(true)}
            />
          ))}
        </MessageScroller>
      )}
    </section>
  );
}
