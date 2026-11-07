"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, ButtonLink } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormSelect } from "@/components/ui/FormSelect";
import { DialogField } from "@/components/dashboard/dialog";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { displayMessagingUserText } from "@/lib/agents/messaging";
import type { AgentChannelConnectionClientView as Channel } from "@/lib/agents/channel-connection-client";
import type { AgentChannelLogEntry } from "@/lib/agents/channel-runtime-logs";
import { LiveControls } from "./LiveToggle";
import { RelativeTime } from "./LogPrimitives";

type Connection = Pick<
  Channel,
  "id" | "name" | "agentId" | "platform" | "platformLabel"
>;
type HistoryMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: string;
  conversation: { id: string; title: string | null };
};
type HistoryPage = {
  messages: HistoryMessage[];
  hasMore: boolean;
  error?: string;
};

export function ChannelObservability({
  slug,
  agentId: initialAgentId = "",
  channelId = "",
}: {
  slug: string;
  agentId?: string;
  channelId?: string;
}) {
  const t = useTranslations("console.agentMessaging");
  const o = useTranslations("console.observability.channels");
  const requestFailed = t("requestFailed");
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(slug)}/agent-channels`;
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = useState(initialAgentId);
  const [selectedId, setSelectedId] = useState(channelId);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const id = useId();

  useEffect(() => {
    void reload;
    const controller = new AbortController();
    let timer: NodeJS.Timeout;
    async function refresh() {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          connections?: Connection[];
          agents?: Array<{ id: string; name: string }>;
          error?: string;
        };
        if (!response.ok) {
          if (
            !controller.signal.aborted &&
            [401, 403, 404].includes(response.status)
          ) {
            setConnections(null);
            setAgents([]);
          }
          throw new Error(data.error || requestFailed);
        }
        if (!controller.signal.aborted) {
          // Retain only observation metadata, never credentials or pairing material.
          setConnections(
            (data.connections ?? []).map(
              ({ id, name, agentId, platform, platformLabel }) => ({
                id,
                name,
                agentId,
                platform,
                platformLabel,
              }),
            ),
          );
          setAgents(data.agents ?? []);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : requestFailed);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 10000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, requestFailed, reload]);

  const available = (connections ?? []).filter(
    (channel) => !agentId || channel.agentId === agentId,
  );
  const selected = selectedId
    ? available.find((channel) => channel.id === selectedId)
    : available[0];
  return (
    <div className="min-w-0 space-y-6">
      <p className="text-sm text-muted-foreground">{o("description")}</p>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <DialogField label={t("bindAgent")} htmlFor={`${id}-agent`}>
          <FormSelect
            id={`${id}-agent`}
            label={t("bindAgent")}
            value={agentId}
            options={[
              { value: "", label: o("allAgents") },
              ...agents.map((agent) => ({
                value: agent.id,
                label: agent.name,
              })),
            ]}
            onValueChange={(value) => {
              setAgentId(value);
              setSelectedId("");
            }}
            className="w-full"
          />
        </DialogField>
        <DialogField label={o("connection")} htmlFor={`${id}-connection`}>
          <FormSelect
            id={`${id}-connection`}
            label={o("connection")}
            value={selected?.id ?? ""}
            options={[
              { value: "", label: o("selectConnection") },
              ...available.map((channel) => ({
                value: channel.id,
                label: `${channel.name} · ${channel.platformLabel || channel.platform} · ${agents.find((agent) => agent.id === channel.agentId)?.name ?? t("noAgent")}`,
              })),
            ]}
            onValueChange={setSelectedId}
            className="w-full"
          />
        </DialogField>
      </div>
      {error && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setReload((value) => value + 1)}
          >
            {o("retry")}
          </Button>
        </div>
      )}
      {!connections && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {o("loading")}
        </p>
      )}
      {connections && !selected && (
        <div className="space-y-3 rounded-xl border border-border p-6 text-sm text-muted-foreground">
          <p>
            {connections.length ? o("noMatchingConnection") : t("noChannels")}
          </p>
          {(agentId || selectedId) && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setAgentId("");
                setSelectedId("");
              }}
            >
              {o("clearFilters")}
            </Button>
          )}
        </div>
      )}
      {selected && (
        <div
          key={`${selected.id}:${selected.agentId}`}
          className="min-w-0 space-y-6"
        >
          <ChannelConversations
            endpoint={endpoint}
            channel={selected}
            slug={slug}
          />
          <ChannelLogs endpoint={endpoint} channel={selected} />
        </div>
      )}
    </div>
  );
}

function ChannelConversations({
  endpoint,
  channel,
  slug,
}: {
  endpoint: string;
  channel: Connection;
  slug: string;
}) {
  const t = useTranslations("console.agentMessaging");
  const o = useTranslations("console.observability.channels");
  const requestFailed = t("requestFailed");
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const latest = useRef<string | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  const merge = useCallback((incoming: HistoryMessage[]) => {
    if (!incoming.length) return;
    setMessages((current) =>
      [
        ...new Map(
          [...current, ...incoming].map((message) => [message.id, message]),
        ).values(),
      ].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }, []);
  useEffect(() => {
    void reload;
    const controller = new AbortController();
    let timer: NodeJS.Timeout;
    async function refresh() {
      let delay = 5000;
      try {
        const response = await fetch(
          `${endpoint}?history=${encodeURIComponent(channel.id)}${latest.current ? `&after=${encodeURIComponent(latest.current)}` : ""}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = (await response.json()) as HistoryPage;
        if (!response.ok) {
          if (
            !controller.signal.aborted &&
            [401, 403, 404].includes(response.status)
          ) {
            olderRequest.current?.abort();
            setLoadingOlder(false);
            setMessages([]);
            setHasOlder(false);
            latest.current = null;
          }
          throw new Error(data.error || requestFailed);
        }
        if (!controller.signal.aborted) {
          if (!latest.current) setHasOlder(data.hasMore);
          else if (data.hasMore) delay = 0;
          latest.current = data.messages.at(-1)?.id ?? latest.current;
          merge(data.messages);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : requestFailed);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(refresh, delay);
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, channel.id, requestFailed, merge, reload]);
  useEffect(() => () => olderRequest.current?.abort(), []);

  async function loadOlder() {
    if (!messages.length || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    try {
      const response = await fetch(
        `${endpoint}?history=${encodeURIComponent(channel.id)}&before=${encodeURIComponent(messages[0].id)}`,
        { cache: "no-store", signal: controller.signal },
      );
      const data = (await response.json()) as HistoryPage;
      if (!response.ok) throw new Error(data.error || requestFailed);
      if (!controller.signal.aborted) {
        merge(data.messages);
        setHasOlder(data.hasMore);
        setError("");
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : requestFailed);
    } finally {
      olderRequest.current = null;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  const conversations = new Map<
    string,
    { latest: HistoryMessage; count: number }
  >();
  for (const message of messages) {
    conversations.set(message.conversation.id, {
      latest: message,
      count: (conversations.get(message.conversation.id)?.count ?? 0) + 1,
    });
  }
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label={t("conversationHistory")}
    >
      <h2 className="text-base font-semibold">{t("conversationHistory")}</h2>
      <p className="text-xs text-muted-foreground">{o("historyDescription")}</p>
      {error && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setReload((value) => value + 1)}
          >
            {o("retry")}
          </Button>
        </div>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {o("loading")}
        </p>
      ) : !messages.length && !error ? (
        <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
          {t("historyEmpty")}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {[...conversations.values()]
          .sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt))
          .map(({ latest: message, count }) => (
            <li
              key={message.conversation.id}
              className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-4"
            >
              <div className="min-w-0 flex-1 basis-48 space-y-2">
                <h3 className="break-words text-sm font-medium">
                  {message.conversation.title || o("untitledConversation")}
                </h3>
                <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <RelativeTime value={message.createdAt} />
                  <span>{o("loadedMessages", { count })}</span>
                </p>
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {message.role === "user"
                    ? displayMessagingUserText(message.text)
                    : message.text}
                </p>
              </div>
              {channel.agentId && (
                <ButtonLink
                  href={`/app/${encodeURIComponent(slug)}/work?agent=${encodeURIComponent(channel.agentId)}&c=${encodeURIComponent(message.conversation.id)}`}
                  variant="secondary"
                  size="sm"
                >
                  {o("openLive")}
                </ButtonLink>
              )}
            </li>
          ))}
      </ul>
      {hasOlder && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loadingOlder}
          onClick={() => void loadOlder()}
        >
          {t("historyLoadOlder")}
        </Button>
      )}
    </section>
  );
}
function ChannelLogs({
  endpoint,
  channel,
}: {
  endpoint: string;
  channel: Connection;
}) {
  const t = useTranslations("console.agentMessaging");
  const viewer = useTranslations("console.observability.viewer");
  const levelId = useId();
  const searchId = useId();
  const [logs, setLogs] = useState<AgentChannelLogEntry[]>([]);
  const [error, setError] = useState("");
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(false);
  const displayed = useRef<AgentChannelLogEntry[]>([]);
  const latest = useRef<AgentChannelLogEntry[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const requestFailed = t("requestFailed");
  useEffect(() => {
    let cancelled = false;
    let timer: NodeJS.Timeout;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(
          `${endpoint}?logs=${encodeURIComponent(channel.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok) {
          if (!cancelled && [401, 403, 404].includes(response.status)) {
            latest.current = [];
            displayed.current = [];
            setLogs([]);
            setPendingCount(0);
          }
          throw new Error(data.error || requestFailed);
        }
        if (!cancelled) {
          const snapshot = data.logs as AgentChannelLogEntry[];
          latest.current = snapshot;
          if (!pausedRef.current) {
            displayed.current = snapshot;
            setLogs(snapshot);
          } else {
            const previous = new Map<string, number>();
            for (const entry of displayed.current) {
              const key = JSON.stringify(entry);
              previous.set(key, (previous.get(key) ?? 0) + 1);
            }
            let count = 0;
            for (const entry of snapshot) {
              const key = JSON.stringify(entry);
              const remaining = previous.get(key) ?? 0;
              if (remaining) previous.set(key, remaining - 1);
              else count++;
            }
            setPendingCount(count);
          }
          setConnected(true);
          setError("");
        }
      } catch (cause) {
        if (!cancelled) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : requestFailed);
        }
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, channel.id, requestFailed]);
  const lastTimestamp = logs.at(-1)?.timestamp;
  useEffect(() => {
    void lastTimestamp;
    const node = scroller.current;
    if (!paused && pinned.current && node) node.scrollTop = node.scrollHeight;
  }, [lastTimestamp, paused]);
  const visible = logs.filter(
    (entry) =>
      (!level || entry.level === level) &&
      (!search ||
        entry.message.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
  );
  const occurrences = new Map<string, number>();
  const keyedLogs = visible.map((entry) => {
    const identity = JSON.stringify(entry);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { entry, key: `${identity}:${occurrence}` };
  });
  const text = visible
    .map(
      (entry) =>
        `${new Date(entry.timestamp).toLocaleString()} [${entry.level.toUpperCase()}] ${entry.message}`,
    )
    .join("\n");
  return (
    <section
      className="min-w-0 space-y-4 border-t border-border pt-6"
      aria-label={t("logs")}
    >
      <h2 className="text-base font-semibold">{t("logs")}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <DialogField
          label={t("logLevel")}
          htmlFor={levelId}
          className="w-full sm:w-40"
        >
          <FormSelect
            id={levelId}
            value={level}
            label={t("logLevel")}
            options={[
              { value: "", label: viewer("all") },
              { value: "info", label: t("logInfo") },
              { value: "error", label: t("logError") },
            ]}
            onValueChange={setLevel}
            className="w-full"
          />
        </DialogField>
        <DialogField
          label={viewer("search")}
          htmlFor={searchId}
          className="min-w-0 flex-1 basis-48"
        >
          <Input
            id={searchId}
            value={search}
            onChange={setSearch}
            className="w-full"
          />
        </DialogField>
        <div className="flex h-11 items-center gap-2">
          <LiveControls
            paused={paused}
            count={pendingCount}
            connected={connected}
            onToggle={() => {
              const next = !pausedRef.current;
              pausedRef.current = next;
              setPaused(next);
              if (!next) {
                displayed.current = latest.current;
                setLogs(latest.current);
                setPendingCount(0);
              }
            }}
          />
          <CopyButton text={text} label={t("copyLogs")} iconOnly />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div
        ref={scroller}
        onScroll={() => {
          const node = scroller.current;
          if (node)
            pinned.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
        className="h-80 overflow-auto rounded-xl border border-border"
        role="log"
        aria-live={paused ? "off" : "polite"}
        aria-label={t("logs")}
      >
        {!visible.length && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t("noLogs")}
          </p>
        )}
        <ol className="divide-y divide-border">
          {keyedLogs.map(({ entry, key }) => (
            <li
              key={key}
              className="grid gap-2 p-3 text-xs sm:grid-cols-[9rem_4rem_minmax(0,1fr)]"
            >
              <RelativeTime value={new Date(entry.timestamp).toISOString()} />
              <span
                className={
                  entry.level === "error"
                    ? "font-medium text-destructive"
                    : "text-muted-foreground"
                }
              >
                {t(entry.level === "error" ? "logError" : "logInfo")}
              </span>
              <p className="min-w-0 whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">
                {entry.message}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
