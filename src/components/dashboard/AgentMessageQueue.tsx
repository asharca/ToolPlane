"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ListPlus, MessageSquarePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import { notify } from "@/components/dashboard/Toaster";
import type {
  AgentMessageQueue,
  QueuedAgentMessage,
} from "@/lib/agents/execution/message-queue";

export type QueueMode = QueuedAgentMessage["mode"];
const emptyQueue: AgentMessageQueue = { messages: [], pendingMessageCount: 0 };

function parseMessageQueue(value: unknown): AgentMessageQueue | null {
  if (!value || typeof value !== "object") return null;
  const queue = value as AgentMessageQueue;
  if (
    !Number.isInteger(queue.pendingMessageCount) ||
    queue.pendingMessageCount < 0 ||
    !Array.isArray(queue.messages)
  )
    return null;
  if (
    !queue.messages.every(
      (message) =>
        message &&
        typeof message.id === "string" &&
        typeof message.text === "string" &&
        (message.mode === "steer" || message.mode === "follow_up"),
    )
  )
    return null;
  return queue;
}

/** Pending input is not a user transcript message until the runtime consumes it. */
export function useAgentMessageQueue({
  agentId,
  conversationId,
  active,
  onRefresh,
}: {
  agentId?: string;
  conversationId?: string | null;
  active: boolean;
  onRefresh?: () => void;
}) {
  const t = useTranslations("console.messageQueue");
  const endpoint =
    agentId && conversationId
      ? `/api/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/queue`
      : null;
  const [state, setState] = useState({
    scope: endpoint,
    queue: emptyQueue,
    pending: false,
    forbidden: false,
    fallback: false,
  });
  const flight = useRef<AbortController | null>(null);
  const scope = useRef(endpoint);
  scope.current = endpoint;
  const observation = useRef(0);
  useEffect(() => {
    setState({
      scope: endpoint,
      queue: emptyQueue,
      pending: false,
      forbidden: false,
      fallback: false,
    });
    return () => {
      flight.current?.abort();
      flight.current = null;
    };
  }, [endpoint]);
  useEffect(() => {
    if (!active)
      setState((current) => ({
        ...current,
        queue: emptyQueue,
        forbidden: false,
        fallback: false,
      }));
  }, [active]);
  const observe = useCallback(
    (value: unknown) => {
      const queue = parseMessageQueue(value);
      if (!queue) return;
      observation.current += 1;
      setState((current) => ({ ...current, scope: endpoint, queue }));
    },
    [endpoint],
  );

  async function request(mode?: QueueMode, text?: string): Promise<boolean> {
    if (!endpoint || flight.current || state.forbidden) return false;
    const controller = new AbortController();
    flight.current = controller;
    const version = observation.current;
    const owned = () =>
      scope.current === endpoint && flight.current === controller;
    setState((current) => ({ ...current, pending: true }));
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(endpoint, {
        method: mode ? "POST" : "DELETE",
        credentials: "same-origin",
        signal: controller.signal,
        ...(mode
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode, text }),
            }
          : {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!owned()) return false;
      if (!response.ok) {
        const code =
          typeof result.error === "string" && t.has(result.error)
            ? result.error
            : "AGENT_QUEUE_FAILED";
        notify(t(code), { severity: "error" });
        if ([401, 403, 404, 410].includes(response.status))
          setState((current) => ({ ...current, forbidden: true }));
        if (response.status === 409)
          setState((current) => ({
            ...current,
            queue: emptyQueue,
            fallback: true,
          }));
        onRefresh?.();
        return false;
      }
      const queue = parseMessageQueue(result.queue);
      if (
        !queue ||
        !["queued", "handled", "cleared"].includes(result.disposition)
      )
        throw new Error();
      // A stream observation arriving during the request supersedes its response.
      if (version === observation.current) observe(queue);
      if (result.disposition !== "queued") notify(t(result.disposition));
      onRefresh?.();
      return true;
    } catch {
      if (owned()) {
        notify(t("AGENT_QUEUE_FAILED"), { severity: "error" });
        onRefresh?.();
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (owned()) {
        flight.current = null;
        setState((current) => ({ ...current, pending: false }));
      }
    }
  }
  return {
    queue: state.scope === endpoint && active ? state.queue : emptyQueue,
    pending: state.scope === endpoint && state.pending,
    forbidden: state.scope === endpoint && state.forbidden,
    fallback: state.scope === endpoint && state.fallback,
    observe,
    send: (mode: QueueMode, text: string) => request(mode, text),
    clear: () => request(),
  };
}

export function AgentMessageQueueView({
  queue,
  onClear,
  disabled = false,
}: {
  queue?: AgentMessageQueue | null;
  onClear?: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations("console.messageQueue");
  if (!queue?.pendingMessageCount) return null;
  return (
    <section
      aria-label={t("pending", { count: queue.pendingMessageCount })}
      className="mb-3 rounded-2xl border border-border bg-muted/40 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span role="status" className="text-xs text-muted-foreground">
          {t("pending", { count: queue.pendingMessageCount })}
        </span>
        {onClear ? (
          <Tooltip content={t("clearHint")}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={t("clear")}
              onClick={onClear}
            >
              <Trash2 className="size-4" />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      <ol className="max-h-40 space-y-2 overflow-y-auto">
        {queue.messages.map((message) => (
          <li
            key={message.id}
            className="flex min-w-0 items-start gap-2 text-sm"
          >
            <span className="shrink-0 text-xs text-muted-foreground">
              {t(message.mode)}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {message.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function AgentQueueActions({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (mode: QueueMode) => void;
}) {
  const t = useTranslations("console.messageQueue");
  return (
    <>
      <Tooltip content={t("steerHint")}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={t("steer")}
          aria-keyshortcuts="Enter"
          onClick={() => onSend("steer")}
        >
          <MessageSquarePlus className="size-4" />
        </Button>
      </Tooltip>
      <Tooltip content={t("followUpHint")}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={t("follow_up")}
          aria-keyshortcuts="Alt+Enter"
          onClick={() => onSend("follow_up")}
        >
          <ListPlus className="size-4" />
        </Button>
      </Tooltip>
    </>
  );
}
