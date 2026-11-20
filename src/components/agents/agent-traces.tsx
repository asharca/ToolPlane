"use client";

import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  Cpu,
  Maximize2,
  Minimize2,
  Search,
  ShieldCheck,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { copyText } from "@/components/dashboard/CopyButton";
import { cn } from "@/lib/utils";

export interface AgentTraceSpan {
  id: string;
  parentId?: string;
  name: string;
  kind: string;
  /** Milliseconds relative to the start of this run. */
  startMs: number;
  durationMs: number;
  status: "running" | "completed" | "failed" | "cancelled";
  inputTokens?: number;
  outputTokens?: number;
  input?: string;
  output?: string;
  error?: string;
  model?: string;
  cost?: number;
  attributes?: Record<string, string | number>;
}

export interface AgentTraceRun {
  id: string;
  name: string;
  status: AgentTraceSpan["status"];
  startedAt: string;
  durationMs: number;
  cost?: number;
  currency?: string;
  retryCount?: number;
  recentLatenciesMs?: number[];
  spans: AgentTraceSpan[];
}

export interface TraceWaterfallLabels {
  trace: (name: string) => string;
  status: Record<AgentTraceSpan["status"], string>;
  retries: (count: number) => string;
  duration: string;
  spans: string;
  tokens: string;
  cost: string;
  showKinds: string;
  kinds: Record<string, string>;
  span: string;
  expand: (name: string) => string;
  collapse: (name: string) => string;
  expandAll: string;
  collapseAll: string;
  search: string;
  clearSearch: string;
  errorsOnly: string;
  zoomIn: string;
  zoomOut: string;
  zoomReset: string;
  previousSpan: string;
  nextSpan: string;
  shareOfTotal: string;
  copy: string;
  copied: string;
  expandText: string;
  collapseText: string;
  noSpans: string;
  noMatches: string;
  resetFilters: string;
  clearSelection: string;
  timing: string;
  start: string;
  end: string;
  model: string;
  inputTokens: string;
  outputTokens: string;
  input: string;
  output: string;
  notRecorded: string;
  attributes: string;
  startedAt: (value: string) => string;
}

export interface TraceWaterfallProps {
  run: AgentTraceRun;
  selectedSpanId?: string | null;
  defaultSelectedSpanId?: string;
  onSelectedSpanChange?: (id: string | null) => void;
  className?: string;
  labels?: Partial<TraceWaterfallLabels>;
}

const KIND_ORDER = [
  "agent",
  "llm",
  "model",
  "tool",
  "retrieval",
  "guardrail",
  "runtime",
];

const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;

const NICE_TICK_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000,
  30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
];

const THIN_SCROLLBAR =
  "[scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--foreground)_18%,transparent)_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/20";

const spanColors: Record<string, string> = {
  agent: "bg-sky-500",
  model: "bg-orange-500",
  llm: "bg-orange-500",
  tool: "bg-teal-500",
  retrieval: "bg-amber-500",
  guardrail: "bg-lime-500",
  runtime: "bg-violet-500",
};

const spanBadgeColors: Record<string, string> = {
  agent: "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  model:
    "border-orange-500/25 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  llm: "border-orange-500/25 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  tool: "border-teal-500/25 bg-teal-500/10 text-teal-600 dark:text-teal-400",
  retrieval:
    "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  guardrail:
    "border-lime-500/25 bg-lime-500/10 text-lime-700 dark:text-lime-300",
  runtime:
    "border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

const spanIconColors: Record<string, string> = {
  agent: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  model: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  llm: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  tool: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  retrieval: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  guardrail: "bg-lime-500/10 text-lime-700 dark:text-lime-300",
  runtime: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

const kindLabels: Record<string, string> = {
  agent: "Agent",
  model: "LLM",
  llm: "LLM",
  tool: "Tool",
  retrieval: "Retrieval",
  guardrail: "Guardrail",
  runtime: "Runtime",
};

const defaultLabels: TraceWaterfallLabels = {
  trace: (name) => `${name} trace waterfall`,
  status: {
    completed: "Completed",
    failed: "Failed",
    running: "Running",
    cancelled: "Cancelled",
  },
  retries: (count) => ` with ${count} ${count === 1 ? "retry" : "retries"}`,
  duration: "Duration",
  spans: "Spans",
  tokens: "Tokens",
  cost: "Cost",
  showKinds: "Filter span kinds",
  kinds: kindLabels,
  span: "Span",
  expand: (name) => `Expand ${name}`,
  collapse: (name) => `Collapse ${name}`,
  expandAll: "Expand all",
  collapseAll: "Collapse nested",
  search: "Search spans…",
  clearSearch: "Clear search",
  errorsOnly: "Errors",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Reset zoom",
  previousSpan: "Previous span",
  nextSpan: "Next span",
  shareOfTotal: "of total",
  copy: "Copy",
  copied: "Copied",
  expandText: "Expand",
  collapseText: "Collapse",
  noSpans: "No spans recorded.",
  noMatches: "No matching spans.",
  resetFilters: "Reset filters",
  clearSelection: "Close details",
  timing: "Timing",
  start: "Start",
  end: "End",
  model: "Model",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  input: "Input",
  output: "Output",
  notRecorded: "No input or output recorded",
  attributes: "Attributes",
  startedAt: (value) =>
    new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }),
};

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0ms";
  if (value < 1) return "<1ms";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)}s`;
  const totalSeconds = value / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatTick(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(2))}s`;
  const minutes = Math.floor(ms / 60_000);
  const remainderMs = ms - minutes * 60_000;
  if (remainderMs < 100) return `${minutes}m`;
  return `${minutes}m ${Number((remainderMs / 1_000).toFixed(1))}s`;
}

function buildTicks(duration: number, zoom: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const target = Math.min(40, Math.max(4, Math.round(5 * zoom)));
  const raw = duration / target;
  let step = NICE_TICK_STEPS.find((candidate) => candidate >= raw);
  if (!step) {
    const hours = Math.ceil(raw / 3_600_000);
    step = hours * 3_600_000;
  }
  const ticks: number[] = [];
  for (let current = 0; current < duration; current += step) {
    if ((current / duration) * 100 <= 93) ticks.push(current);
  }
  return ticks.length ? ticks : [0];
}

function matchesQuery(span: AgentTraceSpan, query: string): boolean {
  if (span.name.toLowerCase().includes(query)) return true;
  if (span.model?.toLowerCase().includes(query)) return true;
  if (span.error?.toLowerCase().includes(query)) return true;
  if (span.input?.toLowerCase().includes(query)) return true;
  if (span.output?.toLowerCase().includes(query)) return true;
  return false;
}

function SpanMark({ kind }: { kind: string }) {
  const normalized = kind.toLowerCase();
  const Icon =
    normalized === "agent"
      ? Bot
      : normalized === "model" || normalized === "llm"
        ? Brain
        : normalized === "guardrail"
          ? ShieldCheck
          : normalized === "retrieval"
            ? Search
            : normalized === "runtime"
              ? Cpu
              : Wrench;
  return <Icon className="size-3.5" aria-hidden="true" />;
}

function PayloadSection({
  title,
  text,
  tone = "default",
  copyLabel,
  copiedLabel,
  expandLabel,
  collapseLabel,
}: {
  title: string;
  text: string;
  tone?: "default" | "error";
  copyLabel: string;
  copiedLabel: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const isLong = text.length > 320 || text.split("\n").length > 8;

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4
          className={cn(
            "font-mono text-[11px] font-medium uppercase tracking-wider",
            tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {title}
        </h4>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? (
                <Minimize2 className="size-3" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-3" aria-hidden="true" />
              )}
              {expanded ? collapseLabel : expandLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? (
              <Check className="size-3 text-emerald-600" aria-hidden="true" />
            ) : (
              <Copy className="size-3" aria-hidden="true" />
            )}
            {copied ? copiedLabel : copyLabel}
          </button>
        </div>
      </div>
      <pre
        className={cn(
          "overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-xl border p-3 font-mono text-xs leading-5",
          THIN_SCROLLBAR,
          !expanded && "max-h-56",
          tone === "error"
            ? "border-rose-500/25 bg-rose-500/10 text-destructive"
            : "border-border bg-background text-foreground",
        )}
      >
        {text}
      </pre>
    </section>
  );
}

export function TraceWaterfall({
  run,
  selectedSpanId,
  defaultSelectedSpanId,
  onSelectedSpanChange,
  className,
  labels,
}: TraceWaterfallProps) {
  const l = {
    ...defaultLabels,
    ...labels,
    kinds: { ...kindLabels, ...labels?.kinds },
    status: { ...defaultLabels.status, ...labels?.status },
  };
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const runKey = `${run.id}:${defaultSelectedSpanId ?? ""}`;
  const [prevRunKey, setPrevRunKey] = useState(runKey);
  const [selected, setSelected] = useState<string | null>(
    defaultSelectedSpanId ?? null,
  );
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [hiddenKinds, setHiddenKinds] = useState<string[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [zoomIndex, setZoomIndex] = useState(0);

  if (prevRunKey !== runKey) {
    setPrevRunKey(runKey);
    setCollapsed([]);
    setHiddenKinds([]);
    setErrorsOnly(false);
    setSearchQuery("");
    setZoomIndex(0);
    setSelected(defaultSelectedSpanId ?? null);
  }

  const zoom = ZOOM_LEVELS[zoomIndex] ?? 1;

  const duration = useMemo(
    () =>
      run.spans.reduce(
        (maximum, span) =>
          Math.max(
            maximum,
            Math.max(0, span.startMs) + Math.max(0, span.durationMs),
          ),
        Math.max(0, run.durationMs),
      ),
    [run.durationMs, run.spans],
  );
  const selectSpan = useCallback(
    (next: string | null) => {
      setSelected(next);
      onSelectedSpanChange?.(next);
    },
    [onSelectedSpanChange],
  );

  const tree = useMemo(() => {
    const children = new Map<string, AgentTraceSpan[]>();
    const byId = new Map(run.spans.map((span) => [span.id, span]));
    for (const span of run.spans) {
      const parent =
        span.parentId && byId.has(span.parentId) ? span.parentId : "";
      const group = children.get(parent) ?? [];
      group.push(span);
      children.set(parent, group);
    }
    const descendantCounts = new Map<string, number>();
    const countDescendants = (spanId: string, seen: Set<string>): number => {
      const cached = descendantCounts.get(spanId);
      if (cached !== undefined) return cached;
      if (seen.has(spanId)) return 0;
      seen.add(spanId);
      let count = 0;
      for (const child of children.get(spanId) ?? []) {
        count += 1 + countDescendants(child.id, seen);
      }
      descendantCounts.set(spanId, count);
      return count;
    };
    for (const span of run.spans) countDescendants(span.id, new Set());
    const nestedParentIds = run.spans
      .filter(
        (span) =>
          Boolean(span.parentId && byId.has(span.parentId)) &&
          (children.get(span.id)?.length ?? 0) > 0,
      )
      .map((span) => span.id);
    return { children, byId, descendantCounts, nestedParentIds };
  }, [run.spans]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const hasActiveFilters =
    hiddenKinds.length > 0 || errorsOnly || normalizedQuery.length > 0;

  const rows = useMemo(() => {
    const { children, descendantCounts } = tree;
    const directMatch = new Set<string>();
    const include = new Set<string>();

    if (hasActiveFilters) {
      for (const span of run.spans) {
        const kindOk = !hiddenKinds.includes(span.kind);
        const errorOk = !errorsOnly || span.status === "failed";
        const queryOk = !normalizedQuery || matchesQuery(span, normalizedQuery);
        if (kindOk && errorOk && queryOk) directMatch.add(span.id);
      }
      const markSubtree = (spanId: string, seen: Set<string>): boolean => {
        if (seen.has(spanId)) return include.has(spanId);
        seen.add(spanId);
        let kept = directMatch.has(spanId);
        for (const child of children.get(spanId) ?? []) {
          if (markSubtree(child.id, seen)) kept = true;
        }
        if (kept) include.add(spanId);
        return kept;
      };
      const seen = new Set<string>();
      for (const span of children.get("") ?? []) markSubtree(span.id, seen);
      for (const span of run.spans) markSubtree(span.id, seen);
    }

    const forceExpand = Boolean(normalizedQuery || errorsOnly);
    const result: {
      span: AgentTraceSpan;
      depth: number;
      hasChildren: boolean;
      descendantCount: number;
      isContextOnly: boolean;
    }[] = [];
    const visited = new Set<string>();

    const visit = (span: AgentTraceSpan, depth: number, hidden: boolean) => {
      if (visited.has(span.id)) return;
      visited.add(span.id);
      if (hasActiveFilters && !include.has(span.id)) return;
      const kids = (children.get(span.id) ?? []).filter(
        (child) => !hasActiveFilters || include.has(child.id),
      );
      if (!hidden) {
        result.push({
          span,
          depth,
          hasChildren: kids.length > 0,
          descendantCount: descendantCounts.get(span.id) ?? 0,
          isContextOnly: hasActiveFilters && !directMatch.has(span.id),
        });
      }
      const isCollapsed = !forceExpand && collapsed.includes(span.id);
      for (const child of kids) visit(child, depth + 1, hidden || isCollapsed);
    };

    for (const span of children.get("") ?? []) visit(span, 0, false);
    for (const span of run.spans) {
      if (!visited.has(span.id)) visit(span, 0, false);
    }
    return result;
  }, [
    collapsed,
    errorsOnly,
    hasActiveFilters,
    hiddenKinds,
    normalizedQuery,
    run.spans,
    tree,
  ]);

  const selectedId = selectedSpanId === undefined ? selected : selectedSpanId;
  const detail = run.spans.find((span) => span.id === selectedId) ?? null;
  const selectedRowIndex = detail
    ? rows.findIndex((row) => row.span.id === detail.id)
    : -1;

  const kindStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const span of run.spans) {
      counts.set(span.kind, (counts.get(span.kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => {
      const ia = KIND_ORDER.indexOf(a.toLowerCase());
      const ib = KIND_ORDER.indexOf(b.toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [run.spans]);

  const errorCount = useMemo(
    () => run.spans.filter((span) => span.status === "failed").length,
    [run.spans],
  );

  const tokenCount = useMemo(
    () =>
      run.spans.reduce(
        (sum, span) => sum + (span.inputTokens ?? 0) + (span.outputTokens ?? 0),
        0,
      ),
    [run.spans],
  );

  const ticks = useMemo(() => buildTicks(duration, zoom), [duration, zoom]);

  const allNestedCollapsed =
    tree.nestedParentIds.length > 0 &&
    tree.nestedParentIds.every((spanId) => collapsed.includes(spanId));

  const scrollRowIntoView = useCallback((spanId: string) => {
    requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      const target = container.querySelector<HTMLElement>(
        `[data-span-id="${CSS.escape(spanId)}"]`,
      );
      target?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  const stepSelection = useCallback(
    (delta: -1 | 1) => {
      if (!rows.length) return;
      const nextIndex =
        selectedRowIndex === -1
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, selectedRowIndex + delta));
      const nextId = rows[nextIndex]?.span.id ?? null;
      if (nextId) {
        selectSpan(nextId);
        scrollRowIntoView(nextId);
      }
    },
    [rows, scrollRowIntoView, selectSpan, selectedRowIndex],
  );

  const changeZoom = useCallback((nextIndex: number) => {
    const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nextIndex));
    setZoomIndex((prevIndex) => {
      if (prevIndex === clamped) return prevIndex;
      const container = scrollRef.current;
      if (container && container.scrollWidth > container.clientWidth) {
        const ratio =
          (container.scrollLeft + container.clientWidth / 2) /
          container.scrollWidth;
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollLeft = Math.max(
            0,
            ratio * el.scrollWidth - el.clientWidth / 2,
          );
        });
      }
      return clamped;
    });
  }, []);

  const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stepSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      stepSelection(-1);
    } else if (event.key === "ArrowLeft" && detail) {
      const hasChildren = (tree.children.get(detail.id)?.length ?? 0) > 0;
      if (hasChildren && !collapsed.includes(detail.id)) {
        event.preventDefault();
        setCollapsed((current) => [...current, detail.id]);
      }
    } else if (event.key === "ArrowRight" && detail) {
      if (collapsed.includes(detail.id)) {
        event.preventDefault();
        setCollapsed((current) => current.filter((item) => item !== detail.id));
      }
    }
  };

  const resetFilters = () => {
    setHiddenKinds([]);
    setErrorsOnly(false);
    setSearchQuery("");
  };

  const summaryItems: Array<[string, string]> = [
    [l.duration, formatDuration(duration)],
    [l.spans, run.spans.length.toLocaleString()],
    ...(tokenCount > 0
      ? ([[l.tokens, tokenCount.toLocaleString()]] as Array<[string, string]>)
      : []),
    ...(run.cost !== undefined
      ? ([
          [
            l.cost,
            new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: run.currency ?? "USD",
              minimumFractionDigits: 3,
            }).format(run.cost),
          ],
        ] as Array<[string, string]>)
      : []),
  ];

  const detailShare =
    detail && duration > 0
      ? Math.min(100, (Math.max(0, detail.durationMs) / duration) * 100)
      : 0;

  const detailMeta = detail
    ? [
        [l.model, detail.model],
        [l.inputTokens, detail.inputTokens?.toLocaleString()],
        [l.outputTokens, detail.outputTokens?.toLocaleString()],
        [
          l.cost,
          detail.cost === undefined ? undefined : `$${detail.cost.toFixed(4)}`,
        ],
      ].filter((entry): entry is [string, string] => entry[1] !== undefined)
    : [];

  return (
    <section
      aria-label={l.trace(run.name)}
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden rounded-3xl border border-border bg-background text-sm text-foreground",
        className,
      )}
    >
      <header className="flex shrink-0 flex-col gap-3 border-b border-border/70 px-4 py-4 pr-14 sm:flex-row sm:items-end sm:justify-between sm:px-6 sm:pr-14">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight sm:text-lg">
              {run.name}
            </h2>
            <span
              className={cn(
                "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium",
                run.status === "failed"
                  ? "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : run.retryCount
                    ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              )}
            >
              {run.status === "completed"
                ? `${l.status.completed}${run.retryCount ? l.retries(run.retryCount) : ""}`
                : l.status[run.status]}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {run.id} ·{" "}
            <time dateTime={run.startedAt}>{l.startedAt(run.startedAt)}</time>
          </p>
        </div>

        <dl className="flex shrink-0 flex-wrap items-baseline gap-x-6 gap-y-2">
          {summaryItems.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="font-mono text-base font-medium tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2.5 border-b border-border px-4 py-2.5 sm:px-6">
        <fieldset
          aria-label={l.showKinds}
          className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
        >
          {kindStats.map(([kind, count]) => {
            const active = !hiddenKinds.includes(kind);
            return (
              <button
                type="button"
                key={kind}
                aria-pressed={active}
                onClick={() =>
                  setHiddenKinds((current) =>
                    current.includes(kind)
                      ? current.filter((item) => item !== kind)
                      : [...current, kind],
                  )
                }
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-border bg-muted/40 text-foreground hover:bg-muted/70"
                    : "border-border/40 bg-transparent text-muted-foreground opacity-45 hover:opacity-75",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    spanColors[kind.toLowerCase()] ?? "bg-primary",
                  )}
                />
                <span>{l.kinds[kind.toLowerCase()] ?? kind}</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {count}
                </span>
              </button>
            );
          })}
          {errorCount > 0 && (
            <button
              type="button"
              aria-pressed={errorsOnly}
              onClick={() => setErrorsOnly((current) => !current)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                errorsOnly
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  : "border-rose-500/20 bg-rose-500/5 text-rose-600/80 hover:bg-rose-500/10 dark:text-rose-400",
              )}
            >
              <CircleAlert className="size-3" aria-hidden="true" />
              <span>{l.errorsOnly}</span>
              <span className="font-mono text-[11px] tabular-nums">
                {errorCount}
              </span>
            </button>
          )}
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={l.search}
              aria-label={l.search}
              className="h-7 w-40 rounded-lg border border-border bg-background pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 sm:w-48 [&::-webkit-search-cancel-button]:hidden"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label={l.clearSearch}
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </div>

          {tree.nestedParentIds.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setCollapsed(allNestedCollapsed ? [] : tree.nestedParentIds)
              }
              title={allNestedCollapsed ? l.expandAll : l.collapseAll}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {allNestedCollapsed ? (
                <ChevronsUpDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronsDownUp className="size-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">
                {allNestedCollapsed ? l.expandAll : l.collapseAll}
              </span>
            </button>
          )}

          <div className="inline-flex h-7 items-center overflow-hidden rounded-lg border border-border bg-background">
            <button
              type="button"
              aria-label={l.zoomOut}
              title={l.zoomOut}
              disabled={zoomIndex === 0}
              onClick={() => changeZoom(zoomIndex - 1)}
              className="inline-flex h-full items-center justify-center px-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
            >
              <ZoomOut className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={l.zoomReset}
              title={l.zoomReset}
              disabled={zoomIndex === 0}
              onClick={() => changeZoom(0)}
              className="h-full min-w-[2.5rem] border-x border-border/70 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:hover:bg-transparent"
            >
              {zoom}×
            </button>
            <button
              type="button"
              aria-label={l.zoomIn}
              title={l.zoomIn}
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              onClick={() => changeZoom(zoomIndex + 1)}
              className="inline-flex h-full items-center justify-center px-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
            >
              <ZoomIn className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div
          ref={scrollRef}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [--trace-label-w:12.5rem] sm:[--trace-label-w:18.5rem]",
            THIN_SCROLLBAR,
          )}
        >
          <div
            className="relative flex min-h-full min-w-[calc(var(--trace-label-w)+18rem)] flex-col"
            style={{
              width:
                zoom === 1
                  ? "100%"
                  : `calc(var(--trace-label-w) + (100% - var(--trace-label-w)) * ${zoom})`,
            }}
          >
            <div className="sticky top-0 z-20 flex h-9 w-full shrink-0 items-stretch border-b border-border bg-background/95 text-xs text-muted-foreground backdrop-blur-sm">
              <div className="sticky left-0 z-30 flex w-[var(--trace-label-w)] shrink-0 items-center justify-between border-r border-border/70 bg-background/95 px-3">
                <span className="truncate font-medium">
                  {l.span}
                  {hasActiveFilters && (
                    <span className="ml-1.5 font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                      ({rows.length}/{run.spans.length})
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[11px]">
                  {l.duration}
                </span>
              </div>
              <div className="relative min-w-0 flex-1 px-3">
                <div className="relative h-full w-full">
                  {ticks.map((tick, index) => {
                    const pct = duration ? (tick / duration) * 100 : 0;
                    return (
                      <span
                        key={tick}
                        className={cn(
                          "absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] tabular-nums",
                          index > 0 && "-translate-x-1/2",
                        )}
                        style={{ left: `${pct}%` }}
                      >
                        {formatTick(tick)}
                      </span>
                    );
                  })}
                  {duration > 0 && (
                    <span className="absolute right-0 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] tabular-nums">
                      {formatTick(duration)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="relative flex-1">
              {rows.length > 0 && (
                <div className="pointer-events-none absolute inset-y-0 left-[calc(var(--trace-label-w)+0.75rem)] right-3 z-0">
                  {ticks.map((tick) => (
                    <span
                      key={tick}
                      className="absolute inset-y-0 w-px bg-border/45"
                      style={{
                        left: `${duration ? (tick / duration) * 100 : 0}%`,
                      }}
                    />
                  ))}
                  {duration > 0 && (
                    <span className="absolute inset-y-0 right-0 w-px bg-border/45" />
                  )}
                </div>
              )}

              {rows.map(
                ({
                  span,
                  depth,
                  hasChildren,
                  descendantCount,
                  isContextOnly,
                }) => {
                  const isSelected = selectedId === span.id;
                  const isCollapsed = collapsed.includes(span.id);
                  const kindKey = span.kind.toLowerCase();
                  const startPct = duration
                    ? Math.min(
                        100,
                        (Math.max(0, span.startMs) / duration) * 100,
                      )
                    : 0;
                  const fullWidth = duration
                    ? Math.min(
                        100 - startPct,
                        (Math.max(0, span.durationMs) / duration) * 100,
                      )
                    : 0;
                  const endPct = startPct + fullWidth;
                  const showLabelRight = endPct <= 84;
                  const showLabelLeft = !showLabelRight && startPct >= 18;
                  const indentDepth = Math.min(depth, 8);

                  return (
                    <div
                      key={span.id}
                      data-span-id={span.id}
                      className={cn(
                        "group relative flex h-10 w-full items-stretch border-b border-border/35 transition-colors",
                        isSelected ? "bg-primary/[0.06]" : "hover:bg-muted/40",
                        isContextOnly && "opacity-55",
                      )}
                    >
                      <div
                        className={cn(
                          "sticky left-0 z-10 flex w-[var(--trace-label-w)] shrink-0 items-center gap-1.5 border-r border-border/60 bg-background pr-3",
                          "before:pointer-events-none before:absolute before:inset-0 before:transition-colors",
                          isSelected
                            ? "before:bg-primary/[0.07]"
                            : "group-hover:before:bg-muted/40",
                        )}
                        style={{ paddingLeft: 10 + indentDepth * 14 }}
                      >
                        {isSelected && (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 left-0 z-20 w-0.5 bg-primary"
                          />
                        )}
                        {indentDepth > 0 &&
                          Array.from({ length: indentDepth }, (_, level) => (
                            <span
                              // biome-ignore lint/suspicious/noArrayIndexKey: Depth guide lines are purely positional tree levels.
                              key={level}
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-border/50"
                              style={{ left: 19 + level * 14 }}
                            />
                          ))}

                        {hasChildren ? (
                          <button
                            type="button"
                            aria-label={
                              isCollapsed
                                ? l.expand(span.name)
                                : l.collapse(span.name)
                            }
                            aria-expanded={!isCollapsed}
                            className="relative z-10 grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() =>
                              setCollapsed((current) =>
                                current.includes(span.id)
                                  ? current.filter((item) => item !== span.id)
                                  : [...current, span.id],
                              )
                            }
                          >
                            <ChevronDown
                              className={cn(
                                "size-3.5 transition-transform",
                                isCollapsed && "-rotate-90",
                              )}
                              aria-hidden="true"
                            />
                          </button>
                        ) : (
                          <span className="w-5 shrink-0" />
                        )}

                        <button
                          type="button"
                          title={span.name}
                          aria-pressed={isSelected}
                          aria-controls={`${id}-detail`}
                          onClick={() => selectSpan(span.id)}
                          onKeyDown={handleRowKeyDown}
                          className={cn(
                            "relative z-10 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded text-left font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            span.status === "failed" &&
                              "text-rose-600 dark:text-rose-400",
                          )}
                        >
                          <span
                            className={cn(
                              "grid size-5 shrink-0 place-items-center rounded-md",
                              span.status === "failed"
                                ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                : (spanIconColors[kindKey] ??
                                    "bg-muted text-muted-foreground"),
                            )}
                          >
                            <SpanMark kind={span.kind} />
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {span.name}
                          </span>
                          {hasChildren &&
                            isCollapsed &&
                            descendantCount > 0 && (
                              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                                +{descendantCount}
                              </span>
                            )}
                          {span.status === "failed" && (
                            <CircleAlert
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                          <span className="ml-1 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                            {formatDuration(span.durationMs)}
                          </span>
                        </button>
                      </div>

                      <button
                        type="button"
                        aria-label={`${span.name}, ${formatDuration(span.durationMs)}`}
                        onClick={() => selectSpan(span.id)}
                        onKeyDown={handleRowKeyDown}
                        className="relative z-[1] min-w-0 flex-1 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <div className="relative h-full w-full">
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute top-1/2 h-3.5 min-w-[4px] -translate-y-1/2 rounded-[4px] transition-shadow",
                              span.status === "failed"
                                ? "bg-rose-500 bg-[repeating-linear-gradient(135deg,transparent,transparent_3px,#ffffff60_3px,#ffffff60_4px)]"
                                : (spanColors[kindKey] ?? "bg-primary"),
                              isSelected &&
                                "ring-2 ring-foreground/25 ring-offset-1 ring-offset-background",
                            )}
                            style={{
                              left: `${startPct}%`,
                              width: `${fullWidth}%`,
                            }}
                          />
                          {(showLabelRight || showLabelLeft) && (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground",
                                span.status === "failed" &&
                                  "text-rose-600 dark:text-rose-400",
                              )}
                              style={{
                                left: `${showLabelRight ? endPct : startPct}%`,
                                transform: showLabelRight
                                  ? "translate(8px, -50%)"
                                  : "translate(calc(-100% - 8px), -50%)",
                              }}
                            >
                              {formatDuration(span.durationMs)}
                            </span>
                          )}
                        </div>
                      </button>
                    </div>
                  );
                },
              )}

              {!rows.length && (
                <div className="flex flex-col items-center justify-center gap-2 p-10 text-center text-xs text-muted-foreground">
                  <p>{hasActiveFilters ? l.noMatches : l.noSpans}</p>
                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {l.resetFilters}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {detail && (
          <aside
            id={`${id}-detail`}
            className="flex max-h-[45dvh] min-h-0 w-full shrink-0 flex-col overflow-hidden border-t border-border bg-muted/[0.15] lg:max-h-none lg:w-[24rem] lg:border-l lg:border-t-0 xl:w-[26rem]"
          >
            <div className="flex shrink-0 items-start gap-2.5 border-b border-border bg-background/80 px-4 py-3">
              <span
                className={cn(
                  "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg [&>svg]:size-4",
                  detail.status === "failed"
                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : (spanIconColors[detail.kind.toLowerCase()] ??
                        "bg-muted text-muted-foreground"),
                )}
              >
                <SpanMark kind={detail.kind} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium",
                      detail.status === "failed"
                        ? "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                        : (spanBadgeColors[detail.kind.toLowerCase()] ??
                            "border-border bg-muted text-foreground"),
                    )}
                  >
                    {l.kinds[detail.kind.toLowerCase()] ?? detail.kind}
                  </span>
                  {detail.status !== "completed" && (
                    <span
                      className={cn(
                        "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium",
                        detail.status === "failed"
                          ? "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                          : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {l.status[detail.status]}
                    </span>
                  )}
                </div>
                <h3 className="mt-1 break-words font-mono text-xs font-semibold leading-5 text-foreground">
                  {detail.name}
                </h3>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {rows.length > 1 && selectedRowIndex !== -1 && (
                  <>
                    <button
                      type="button"
                      aria-label={l.previousSpan}
                      title={l.previousSpan}
                      disabled={selectedRowIndex <= 0}
                      onClick={() => stepSelection(-1)}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
                    >
                      <ChevronUp className="size-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={l.nextSpan}
                      title={l.nextSpan}
                      disabled={selectedRowIndex >= rows.length - 1}
                      onClick={() => stepSelection(1)}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
                    >
                      <ChevronDown className="size-4" aria-hidden="true" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label={l.clearSelection}
                  title={l.clearSelection}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => selectSpan(null)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div
              className={cn(
                "min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4",
                THIN_SCROLLBAR,
              )}
            >
              <section className="rounded-xl border border-border bg-background p-3.5">
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {l.timing}
                  </h4>
                  <div className="flex items-baseline gap-2 font-mono tabular-nums">
                    <span className="text-sm font-semibold">
                      {formatDuration(detail.durationMs)}
                    </span>
                    {duration > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {detailShare.toFixed(1)}% {l.shareOfTotal}
                      </span>
                    )}
                  </div>
                </div>
                <div className="relative mt-2.5 h-2 rounded-full bg-muted">
                  <span
                    className={cn(
                      "absolute inset-y-0 min-w-[3px] rounded-full",
                      detail.status === "failed"
                        ? "bg-rose-500"
                        : (spanColors[detail.kind.toLowerCase()] ??
                            "bg-primary"),
                    )}
                    style={{
                      left: `${duration ? Math.min(100, (Math.max(0, detail.startMs) / duration) * 100) : 0}%`,
                      width: `${detailShare}%`,
                    }}
                  />
                </div>
                <p className="mt-2 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
                  <span>
                    {l.start} +{formatDuration(detail.startMs)}
                  </span>
                  <span>
                    {l.end} +
                    {formatDuration(detail.startMs + detail.durationMs)}
                  </span>
                </p>
              </section>

              {detailMeta.length > 0 && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl border border-border bg-background p-3.5">
                  {detailMeta.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-[11px] text-muted-foreground">
                        {label}
                      </dt>
                      <dd
                        title={value}
                        className="mt-0.5 truncate font-mono text-xs font-medium tabular-nums"
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              {detail.attributes &&
                Object.keys(detail.attributes).length > 0 && (
                  <section className="space-y-1.5">
                    <h4 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {l.attributes}
                    </h4>
                    <dl className="divide-y divide-border rounded-xl border border-border bg-background">
                      {Object.entries(detail.attributes).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex justify-between gap-3 px-3 py-2 font-mono text-xs"
                        >
                          <dt className="text-muted-foreground">{key}</dt>
                          <dd className="text-right tabular-nums">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}

              {detail.error && (
                <PayloadSection
                  key={`${detail.id}:error`}
                  title={l.status.failed}
                  text={detail.error}
                  tone="error"
                  copyLabel={l.copy}
                  copiedLabel={l.copied}
                  expandLabel={l.expandText}
                  collapseLabel={l.collapseText}
                />
              )}

              {detail.input !== undefined && (
                <PayloadSection
                  key={`${detail.id}:input`}
                  title={l.input}
                  text={detail.input}
                  copyLabel={l.copy}
                  copiedLabel={l.copied}
                  expandLabel={l.expandText}
                  collapseLabel={l.collapseText}
                />
              )}

              {detail.output !== undefined && (
                <PayloadSection
                  key={`${detail.id}:output`}
                  title={l.output}
                  text={detail.output}
                  copyLabel={l.copy}
                  copiedLabel={l.copied}
                  expandLabel={l.expandText}
                  collapseLabel={l.collapseText}
                />
              )}

              {detail.error === undefined &&
                detail.input === undefined &&
                detail.output === undefined && (
                  <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    {l.notRecorded}
                  </p>
                )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
