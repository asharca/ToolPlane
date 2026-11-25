"use client";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";

import { ArrowDown, RefreshCw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/motion/input";
import { apiRequest } from "@/lib/client/api";
import { CopyButton } from "./CopyButton";
import { StatusBadge } from "./StatusBadge";

type LogLevelFilter = "all" | "warn" | "error";

function detectLogLevel(line: string): "error" | "warn" | "info" {
  if (/\b(error|fatal|exception|panic|traceback|err!)\b/i.test(line)) {
    return "error";
  }
  if (/\b(warn|warning|deprecated)\b/i.test(line)) {
    return "warn";
  }
  return "info";
}

function highlightQuery(text: string, query: string): ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length <= 1) return text;
  const lower = query.toLocaleLowerCase();
  return parts.map((part, index) =>
    part.toLocaleLowerCase() === lower ? (
      <mark
        // biome-ignore lint/suspicious/noArrayIndexKey: Static split tokens within a single log line.
        key={index}
        className="rounded-xs bg-primary/25 px-0.5 text-foreground"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export type DeploymentRuntimeSnapshotView = {
  status: string;
  phase: string;
  generation: string;
  containerName?: string;
  containerState?: string;
  imageState?: string;
  startedAt?: string;
  lastActivityAt?: string;
  updatedAt?: string;
};

type DeploymentRuntimeLogChunkView = {
  generation: string | null;
  cursor: number;
  nextCursor: number;
  reset: boolean;
  text: string;
  truncated?: boolean;
};

type RuntimeResponse = {
  snapshot: DeploymentRuntimeSnapshotView | null;
  logs: DeploymentRuntimeLogChunkView;
};

const TERMINAL_STATUSES = new Set(["stopped", "error"]);

type RuntimeLogView = {
  text: string;
  truncated: boolean;
};

function isTerminalStatus(status: string | null | undefined): boolean {
  return !status || TERMINAL_STATUSES.has(status);
}

function readablePhase(phase: string | undefined): string {
  if (!phase) return "—";
  return phase.replaceAll(/[_-]+/g, " ");
}

export function ContainerLogs({
  deploymentId,
  initialSnapshot,
  initialLogs,
  initialStatus,
  title,
  refreshLabel,
  emptyLabel,
  unavailableLabel,
  statusLabel,
  phaseLabel,
  imageStateLabel,
  containerStateLabel,
  syncErrorLabel,
  truncatedLabel,
}: {
  deploymentId: string;
  initialSnapshot: DeploymentRuntimeSnapshotView | null;
  initialLogs: DeploymentRuntimeLogChunkView | null;
  initialStatus: string;
  title: string;
  refreshLabel: string;
  emptyLabel: string;
  unavailableLabel: string;
  statusLabel: string;
  phaseLabel: string;
  imageStateLabel: string;
  containerStateLabel: string;
  syncErrorLabel: string;
  truncatedLabel: string;
}) {
  const router = useRouter();
  const t = useTranslations("console.mcp");
  const common = useTranslations("common");
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>("all");
  const [wrap, setWrap] = useState(true);
  const [following, setFollowing] = useState(true);
  const followRef = useRef(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] =
    useState<DeploymentRuntimeSnapshotView | null>(initialSnapshot);
  const [runtimeStatus, setRuntimeStatus] = useState(
    initialSnapshot?.status ?? initialStatus,
  );
  const [logView, setLogView] = useState<RuntimeLogView>({
    text: initialLogs?.text ?? "",
    truncated: Boolean(initialLogs?.truncated),
  });
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const generationRef = useRef<string | null>(
    initialLogs?.generation ?? initialSnapshot?.generation ?? null,
  );
  const cursorRef = useRef(initialLogs?.nextCursor ?? 0);
  const statusRef = useRef(initialSnapshot?.status ?? initialStatus);
  const inFlightRef = useRef(false);
  const hasLogs = Boolean(logView.text.trim());
  const currentStatus = runtimeStatus;
  const parsedLines = useMemo(() => {
    if (!logView.text) return [];
    const rawLines = logView.text.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
      rawLines.pop();
    }
    return rawLines.map((line, index) => ({
      number: index + 1,
      text: line,
      level: detectLogLevel(line),
    }));
  }, [logView.text]);
  const visibleLines = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return parsedLines.filter((item) => {
      if (levelFilter === "error" && item.level !== "error") return false;
      if (
        levelFilter === "warn" &&
        item.level !== "warn" &&
        item.level !== "error"
      )
        return false;
      if (term && !item.text.toLocaleLowerCase().includes(term)) return false;
      return true;
    });
  }, [levelFilter, parsedLines, query]);
  const visibleText = useMemo(
    () => visibleLines.map((item) => item.text).join("\n"),
    [visibleLines],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Text and follow-state changes trigger a DOM measurement after rendering the log content.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followRef.current && !query)
      viewport.scrollTop = viewport.scrollHeight;
  }, [visibleText, following, query]);

  function changeQuery(value: string) {
    setQuery(value);
    if (value) {
      followRef.current = false;
      setFollowing(false);
    }
  }

  // The endpoint only exposes supervisor-captured stderr. Docker stdout is MCP
  // protocol traffic and must never be rendered in the dashboard.
  const sync = useCallback(
    async (manual = false) => {
      if (inFlightRef.current) {
        if (manual) router.refresh();
        return;
      }

      inFlightRef.current = true;
      if (manual) setRefreshing(true);
      let hasMore = true;
      while (hasMore) {
        const query = new URLSearchParams({
          cursor: String(cursorRef.current),
          limit: "65536",
        });
        if (generationRef.current)
          query.set("generation", generationRef.current);

        const result = await apiRequest<RuntimeResponse>(
          `/api/v1/mcp/${deploymentId}/runtime?${query}`,
          { cache: "no-store" },
        );
        if (!result.ok) {
          setSyncError(true);
          break;
        }
        const data = result.data;
        const chunk = data.logs;
        const previousGeneration = generationRef.current;
        const generationChanged = Boolean(
          previousGeneration &&
            chunk.generation &&
            previousGeneration !== chunk.generation,
        );
        const shouldReset = chunk.reset || generationChanged;

        setLogView((previous) => ({
          text: shouldReset ? chunk.text : `${previous.text}${chunk.text}`,
          truncated:
            (shouldReset ? false : previous.truncated) ||
            Boolean(chunk.truncated),
        }));
        generationRef.current = chunk.generation;
        cursorRef.current = chunk.nextCursor;
        hasMore = chunk.nextCursor > chunk.cursor;
        setSnapshot(data.snapshot);
        setSyncError(false);

        const nextStatus = data.snapshot?.status ?? "stopped";
        const previousStatus = statusRef.current;
        statusRef.current = nextStatus;
        setRuntimeStatus(nextStatus);
        if (previousStatus !== nextStatus) {
          // Refresh server-rendered controls and the header as soon as the
          // supervisor reports a lifecycle status transition.
          router.refresh();
        }
      }
      inFlightRef.current = false;
      if (manual) setRefreshing(false);
    },
    [deploymentId, router],
  );

  useEffect(() => {
    // A Logs visit always gets one fresh chunk. Provisioning emits progress at
    // one-second intervals; a healthy runtime keeps a lower-frequency tail so
    // later stderr is still visible without keeping a hot polling loop alive.
    const firstPoll = window.setTimeout(() => void sync(), 0);
    if (isTerminalStatus(currentStatus)) {
      return () => window.clearTimeout(firstPoll);
    }
    const intervalMs = currentStatus === "provisioning" ? 1000 : 3000;
    const timer = window.setInterval(() => void sync(), intervalMs);
    return () => {
      window.clearTimeout(firstPoll);
      window.clearInterval(timer);
    };
  }, [currentStatus, sync]);

  async function refresh() {
    await sync(true);
    router.refresh();
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <dl className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">{statusLabel}</dt>
              <dd>
                <StatusBadge status={currentStatus} />
              </dd>
            </div>
            <div className="flex items-center gap-1">
              <dt>{phaseLabel}:</dt>
              <dd className="font-medium text-foreground">
                {readablePhase(snapshot?.phase)}
              </dd>
            </div>
            {snapshot?.imageState ? (
              <div className="flex items-center gap-1">
                <dt>{imageStateLabel}:</dt>
                <dd className="font-medium text-foreground">
                  {snapshot.imageState}
                </dd>
              </div>
            ) : null}
            {snapshot?.containerState ? (
              <div className="flex items-center gap-1">
                <dt>{containerStateLabel}:</dt>
                <dd className="font-medium text-foreground">
                  {snapshot.containerState}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <Button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          variant="secondary"
          size="sm"
        >
          <RefreshCw
            className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
          />
          {refreshLabel}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={changeQuery}
          aria-label={t("searchRuntimeLogs")}
          placeholder={t("searchRuntimeLogs")}
          leftIcon={<Search className="size-4" />}
          className="w-full sm:max-w-xs"
        />
        <Tabs
          value={levelFilter}
          onValueChange={(val) => setLevelFilter(val as LogLevelFilter)}
          variant="segment"
        >
          <TabsList>
            <TabsTrigger value="all">{common("all")}</TabsTrigger>
            <TabsTrigger value="warn">WARN</TabsTrigger>
            <TabsTrigger value="error">ERROR</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          type="button"
          variant={wrap ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          {t("wrapLogs")}
        </Button>
        <Button
          type="button"
          variant={following ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={following}
          disabled={Boolean(query)}
          onClick={() => {
            followRef.current = !following;
            setFollowing(!following);
          }}
        >
          {t("followLatestLogs")}
        </Button>
        {following && !isTerminalStatus(currentStatus) ? (
          <AnimatedBadge status="loading" size="sm">
            {t("followLatestLogs")}
          </AnimatedBadge>
        ) : null}
        {visibleText ? (
          <CopyButton text={visibleText} label={t("copyVisibleLogs")} />
        ) : null}
      </div>
      <div className="relative">
        <section
          ref={viewportRef}
          aria-label={title}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the runtime log viewport.
          tabIndex={0}
          onScroll={(event) => {
            const viewport = event.currentTarget;
            const atBottom =
              !query &&
              viewport.scrollHeight -
                viewport.scrollTop -
                viewport.clientHeight <=
                32;
            followRef.current = atBottom;
            setFollowing(atBottom);
          }}
          className="h-[28rem] max-h-[60dvh] min-h-48 overflow-auto rounded-lg border border-border bg-background p-3"
        >
          {visibleLines.length > 0 ? (
            <div className="font-mono text-xs leading-relaxed">
              {visibleLines.map((line) => (
                <div
                  key={line.number}
                  className={`flex items-baseline gap-3 rounded-xs px-1.5 py-0.5 ${
                    line.level === "error"
                      ? "bg-destructive/10 text-destructive"
                      : line.level === "warn"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        : "text-foreground hover:bg-muted/40"
                  }`}
                >
                  <span className="w-8 shrink-0 select-none text-right text-[11px] tabular-nums text-muted-foreground/60">
                    {line.number}
                  </span>
                  <span
                    className={`min-w-0 flex-1 ${
                      wrap
                        ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
                        : "whitespace-pre"
                    }`}
                  >
                    {highlightQuery(line.text, query.trim())}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="p-1 text-sm text-muted-foreground">
              {hasLogs && (query || levelFilter !== "all")
                ? t("noMatchingRuntimeLogs")
                : emptyLabel}
            </p>
          )}
        </section>
        {!following && hasLogs && !query ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute right-4 bottom-4 shadow-md"
            onClick={() => {
              followRef.current = true;
              setFollowing(true);
              if (viewportRef.current) {
                viewportRef.current.scrollTop =
                  viewportRef.current.scrollHeight;
              }
            }}
          >
            <ArrowDown className="size-3.5" />
            {t("followLatestLogs")}
          </Button>
        ) : null}
      </div>
      {!snapshot ? (
        <p className="text-xs text-muted-foreground">{unavailableLabel}</p>
      ) : null}

      {logView.truncated ? (
        <p className="text-xs text-muted-foreground">{truncatedLabel}</p>
      ) : null}
      {syncError ? (
        <p className="text-xs text-destructive dark:text-destructive">
          {syncErrorLabel}
        </p>
      ) : null}
    </section>
  );
}
