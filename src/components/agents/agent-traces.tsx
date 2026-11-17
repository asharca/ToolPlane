"use client";

// beUI Registry `agent-traces` (https://asharca.github.io/ui/r/agent-traces/raw.txt).
// Only TraceWaterfall is installed; `labels` is the ToolPlane localization adapter.
import {
  Bot,
  Brain,
  ChevronDown,
  CircleAlert,
  Pause,
  RotateCcw,
  Search,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { EASE_OUT } from "@/lib/ease";
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
  replay: string;
  pause: string;
  span: string;
  playhead: string;
  expand: (name: string) => string;
  collapse: (name: string) => string;
  noSpans: string;
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

const spanColors: Record<string, string> = {
  agent: "bg-sky-500",
  model: "bg-orange-500",
  llm: "bg-orange-500",
  tool: "bg-teal-500",
  retrieval: "bg-amber-500",
  guardrail: "bg-lime-500",
};
const kindLabels: Record<string, string> = {
  agent: "Agent",
  model: "LLM",
  llm: "LLM",
  tool: "Tool",
  retrieval: "Retrieval",
  guardrail: "Guardrail",
};
const defaultLabels: TraceWaterfallLabels = {
  trace: (name) => `${name} trace waterfall`,
  status: {
    completed: "Completed",
    failed: "failed",
    running: "running",
    cancelled: "cancelled",
  },
  retries: (count) => ` with ${count} ${count === 1 ? "retry" : "retries"}`,
  duration: "Duration",
  spans: "Spans",
  tokens: "Tokens",
  cost: "Cost",
  showKinds: "Show span kinds",
  kinds: kindLabels,
  replay: "Replay",
  pause: "Pause",
  span: "Span",
  playhead: "Trace playhead",
  expand: (name) => `Expand ${name}`,
  collapse: (name) => `Collapse ${name}`,
  noSpans: "No spans recorded.",
  clearSelection: "Clear selection",
  timing: "Timing",
  start: "Start",
  end: "End",
  model: "Model",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  input: "input",
  output: "output",
  notRecorded: "Not recorded",
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
const milliseconds = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
function SpanMark({ kind }: { kind: string }) {
  const Icon =
    kind === "agent"
      ? Bot
      : kind === "model" || kind === "llm"
        ? Brain
        : kind === "guardrail"
          ? ShieldCheck
          : kind === "retrieval"
            ? Search
            : Wrench;
  return <Icon className="size-3.5" />;
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
  };
  const reduce = useReducedMotion();
  const id = useId();
  const [selected, setSelected] = useState<string | null>(
    defaultSelectedSpanId ?? null,
  );
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [dimmed, setDimmed] = useState<string[]>([]);
  const duration = run.spans.reduce(
    (maximum, span) =>
      Math.max(
        maximum,
        Math.max(0, span.startMs) + Math.max(0, span.durationMs),
      ),
    Math.max(0, run.durationMs),
  );
  const [playhead, setPlayhead] = useState(duration);
  const [playing, setPlaying] = useState(false);
  // Snapshot replay position without restarting the timer on each playhead tick.
  const replay = useRef({ runId: run.id, playhead });
  replay.current.playhead = playhead;
  useEffect(() => {
    replay.current = { runId: run.id, playhead: duration };
    setPlayhead(duration);
    setPlaying(false);
    setCollapsed([]);
    setSelected(defaultSelectedSpanId ?? null);
  }, [run.id, duration, defaultSelectedSpanId]);
  useEffect(() => {
    if (!playing) return;
    const session = replay.current;
    const start = performance.now() - session.playhead;
    const timer = window.setInterval(() => {
      if (replay.current !== session) return;
      const next = Math.min(duration, performance.now() - start);
      setPlayhead(next);
      if (next >= duration) setPlaying(false);
    }, 40);
    return () => window.clearInterval(timer);
  }, [playing, duration]);
  const rows = useMemo(() => {
    const children = new Map<string, AgentTraceSpan[]>();
    const byId = new Map(run.spans.map((span) => [span.id, span]));
    for (const span of run.spans) {
      const parent =
        span.parentId && byId.has(span.parentId) ? span.parentId : "";
      const group = children.get(parent) ?? [];
      group.push(span);
      children.set(parent, group);
    }
    const result: {
      span: AgentTraceSpan;
      depth: number;
      hasChildren: boolean;
    }[] = [];
    const visited = new Set<string>();
    const visit = (span: AgentTraceSpan, depth: number, hidden: boolean) => {
      if (visited.has(span.id)) return;
      visited.add(span.id);
      if (!hidden)
        result.push({
          span,
          depth,
          hasChildren: !!children.get(span.id)?.length,
        });
      for (const child of children.get(span.id) ?? [])
        visit(child, depth + 1, hidden || collapsed.includes(span.id));
    };
    for (const span of children.get("") ?? []) visit(span, 0, false);
    for (const span of run.spans)
      if (!visited.has(span.id)) visit(span, 0, false);
    return result;
  }, [run.spans, collapsed]);
  const selectedId = selectedSpanId === undefined ? selected : selectedSpanId;
  const detail = run.spans.find((span) => span.id === selectedId);
  const kinds = [...new Set(run.spans.map((span) => span.kind))].sort(
    (a, b) =>
      ["agent", "llm", "model", "tool", "retrieval", "guardrail"].indexOf(
        a.toLowerCase(),
      ) -
      ["agent", "llm", "model", "tool", "retrieval", "guardrail"].indexOf(
        b.toLowerCase(),
      ),
  );
  const tickStep = Math.max(1, Math.ceil(duration / 5000)) * 1000;
  const ticks = Array.from(
    { length: Math.max(1, Math.ceil(duration / tickStep)) },
    (_, index) => index * tickStep,
  );
  const tokenCount = run.spans.reduce(
    (sum, span) => sum + (span.inputTokens ?? 0) + (span.outputTokens ?? 0),
    0,
  );
  return (
    <section
      aria-label={l.trace(run.name)}
      className={cn(
        "mx-auto w-full max-w-6xl overflow-clip rounded-3xl border border-border bg-background text-sm text-foreground",
        className,
      )}
    >
      <header className="flex flex-col gap-5 px-4 pt-4 sm:px-6 sm:pt-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="mb-2 truncate font-mono text-xs text-muted-foreground">
            {run.id} ·{" "}
            <time dateTime={run.startedAt}>{l.startedAt(run.startedAt)}</time>
          </p>
          <h2 className="text-xl font-medium">{run.name}</h2>
          <span
            className={cn(
              "mt-2 inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium",
              run.status === "failed"
                ? "border-rose-500/25 bg-rose-500/10 text-rose-600"
                : run.retryCount
                  ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-emerald-500/25 bg-emerald-500/10 text-emerald-600",
            )}
          >
            {run.status === "completed"
              ? `${l.status.completed}${run.retryCount ? l.retries(run.retryCount) : ""}`
              : l.status[run.status]}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-[repeat(4,4.5rem)]">
          {[
            [l.duration, milliseconds(duration)],
            [l.spans, run.spans.length.toLocaleString()],
            [l.tokens, tokenCount.toLocaleString()],
            [
              l.cost,
              run.cost === undefined
                ? "—"
                : new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: run.currency ?? "USD",
                    minimumFractionDigits: 3,
                  }).format(run.cost),
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
              <dd className="font-mono text-lg tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </header>
      <div className="mt-5 flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <fieldset
          aria-label={l.showKinds}
          className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0"
        >
          {kinds.map((kind) => (
            <button
              type="button"
              key={kind}
              aria-pressed={!dimmed.includes(kind)}
              onClick={() =>
                setDimmed(
                  dimmed.includes(kind)
                    ? dimmed.filter((item) => item !== kind)
                    : [...dimmed, kind],
                )
              }
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full border border-border/50 px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                dimmed.includes(kind) && "opacity-30",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  spanColors[kind.toLowerCase()] ?? "bg-primary",
                )}
              />
              {l.kinds[kind.toLowerCase()] ?? kind}
            </button>
          ))}
        </fieldset>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">
            {milliseconds(playhead)} / {milliseconds(duration)}
          </span>
          <button
            type="button"
            className={
              "inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-4 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            }
            disabled={!duration}
            onClick={() => {
              if (!playing && playhead >= duration) setPlayhead(0);
              setPlaying(!playing);
            }}
          >
            {playing ? (
              <Pause className="size-4" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            {playing ? l.pause : l.replay}
          </button>
        </div>
      </div>
      <div
        className={cn("grid", detail && "xl:grid-cols-[minmax(0,1fr)_22rem]")}
      >
        <div className="min-w-0 overflow-x-auto px-2 pb-3 pt-2 sm:px-3">
          <div className="relative min-w-[576px]">
            <div className="grid h-9 grid-cols-[15rem_minmax(0,1fr)] items-center text-xs text-muted-foreground">
              <span className="pl-2">{l.span}</span>
              <div className="relative mx-3 h-full">
                {ticks.map((tick) => (
                  <span
                    key={tick}
                    className="absolute top-2 font-mono"
                    style={{
                      left: `${duration ? (tick / duration) * 100 : 0}%`,
                    }}
                  >
                    {tick ? `${tick / 1000}s` : "0ms"}
                  </span>
                ))}
                <input
                  className="absolute inset-0 h-full w-full cursor-col-resize opacity-0"
                  aria-label={l.playhead}
                  type="range"
                  min={0}
                  max={Math.max(1, duration)}
                  step={1}
                  value={playhead}
                  onChange={(event) => {
                    setPlaying(false);
                    setPlayhead(Number(event.target.value));
                  }}
                />
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-0 left-[calc(15rem+0.75rem)] right-3 top-9">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute inset-y-0 w-px bg-border/50"
                  style={{ left: `${duration ? (tick / duration) * 100 : 0}%` }}
                />
              ))}
              <span
                className={cn(
                  "absolute inset-y-0 z-10 w-px bg-foreground/50",
                  !playing && playhead >= duration && "hidden",
                )}
                style={{
                  left: `${duration ? (playhead / duration) * 100 : 0}%`,
                }}
              />
            </div>
            {rows.map(({ span, depth, hasChildren }) => {
              const width = duration
                ? (Math.min(
                    Math.max(0, playhead - span.startMs),
                    Math.max(0, span.durationMs),
                  ) /
                    duration) *
                  100
                : 0;
              const fullWidth = duration
                ? (Math.max(0, span.durationMs) / duration) * 100
                : 0;
              return (
                <div
                  key={span.id}
                  className={cn(
                    "relative grid h-[42px] grid-cols-[15rem_minmax(0,1fr)] items-center rounded-full",
                    selectedId === span.id && "bg-muted/60",
                    (dimmed.includes(span.kind) || span.startMs > playhead) &&
                      "opacity-30",
                  )}
                  data-span-id={span.id}
                >
                  <div
                    className="flex min-w-0 items-center gap-1.5 pr-3"
                    style={{ paddingLeft: 8 + Math.min(depth, 8) * 14 }}
                  >
                    {hasChildren ? (
                      <button
                        type="button"
                        aria-label={
                          collapsed.includes(span.id)
                            ? l.expand(span.name)
                            : l.collapse(span.name)
                        }
                        aria-expanded={!collapsed.includes(span.id)}
                        className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
                          setCollapsed(
                            collapsed.includes(span.id)
                              ? collapsed.filter((item) => item !== span.id)
                              : [...collapsed, span.id],
                          )
                        }
                      >
                        <ChevronDown
                          className={cn(
                            "size-3.5",
                            collapsed.includes(span.id) && "-rotate-90",
                          )}
                        />
                      </button>
                    ) : (
                      <span className="w-5 shrink-0" />
                    )}
                    <button
                      type="button"
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-1.5 rounded text-left font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        span.status === "failed" && "text-rose-500",
                      )}
                      aria-pressed={selectedId === span.id}
                      aria-controls={`${id}-detail`}
                      onClick={() => {
                        setSelected(span.id);
                        onSelectedSpanChange?.(span.id);
                      }}
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                        <SpanMark kind={span.kind} />
                      </span>
                      <span className="truncate">{span.name}</span>
                      {span.status === "failed" && (
                        <CircleAlert className="size-3 shrink-0" />
                      )}
                    </button>
                    {!span.parentId && (
                      <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {milliseconds(span.durationMs)}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`${span.name}, ${milliseconds(span.durationMs)}`}
                    onClick={() => {
                      setSelected(span.id);
                      onSelectedSpanChange?.(span.id);
                    }}
                    className="relative mx-3 h-[42px] outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <motion.span
                      aria-hidden="true"
                      initial={false}
                      animate={{ scaleX: fullWidth ? width / fullWidth : 0 }}
                      transition={{
                        duration: reduce || playing ? 0 : 0.15,
                        ease: EASE_OUT,
                      }}
                      className={cn(
                        "absolute top-1/2 h-3 -translate-y-1/2 rounded-full",
                        span.status === "failed"
                          ? "bg-rose-500 bg-[repeating-linear-gradient(135deg,transparent,transparent_3px,#ffffff60_3px,#ffffff60_4px)]"
                          : (spanColors[span.kind.toLowerCase()] ??
                              "bg-primary"),
                        selectedId === span.id &&
                          "ring-2 ring-foreground/15 ring-offset-1 ring-offset-background",
                      )}
                      style={{
                        left: `${duration ? (Math.max(0, span.startMs) / duration) * 100 : 0}%`,
                        width: `${fullWidth}%`,
                        transformOrigin: "left center",
                      }}
                    />
                    {!!span.parentId && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-xs text-muted-foreground",
                          span.status === "failed" && "text-rose-500",
                        )}
                        style={{
                          left: `${duration ? ((span.startMs + (span.startMs + span.durationMs > duration * 0.8 ? 0 : span.durationMs)) / duration) * 100 : 0}%`,
                          transform:
                            span.startMs + span.durationMs > duration * 0.8
                              ? "translateX(calc(-100% - 8px))"
                              : "translateX(8px)",
                        }}
                      >
                        {milliseconds(span.durationMs)}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
            {!rows.length && (
              <p className="p-8 text-center text-xs text-muted-foreground">
                {l.noSpans}
              </p>
            )}
          </div>
        </div>
        <AgentDisclosure
          id={`${id}-detail`}
          open={!!detail}
          className="border-t border-border xl:border-l xl:border-t-0"
        >
          {detail && (
            <aside className="space-y-6 p-4 sm:p-6">
              <div className="flex min-h-12 items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&>svg]:size-4">
                  <SpanMark kind={detail.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium",
                      detail.status === "failed"
                        ? "border-rose-500/25 bg-rose-500/10 text-rose-600"
                        : "border-orange-500/25 bg-orange-500/10 text-orange-600",
                    )}
                  >
                    {l.kinds[detail.kind.toLowerCase()] ?? detail.kind}
                  </span>
                  <h3 className="mt-1.5 break-all font-mono text-sm font-medium">
                    {detail.name}
                  </h3>
                </div>
                <button
                  type="button"
                  aria-label={l.clearSelection}
                  className="rounded-full p-1 text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setSelected(null);
                    onSelectedSpanChange?.(null);
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <section>
                <div className="flex items-baseline justify-between gap-3">
                  <h4 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                    {l.timing}
                  </h4>
                  <span className="font-mono text-sm tabular-nums">
                    {milliseconds(detail.durationMs)}
                  </span>
                </div>
                <div className="relative mt-3 h-2 rounded-full bg-muted">
                  <span
                    className={cn(
                      "absolute inset-y-0 rounded-full",
                      spanColors[detail.kind.toLowerCase()] ?? "bg-primary",
                    )}
                    style={{
                      left: `${duration ? (detail.startMs / duration) * 100 : 0}%`,
                      width: `${duration ? (detail.durationMs / duration) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p className="mt-2 flex justify-between font-mono text-xs tabular-nums text-muted-foreground">
                  <span>
                    {l.start} {milliseconds(detail.startMs)}
                  </span>
                  <span>
                    {l.end} {milliseconds(detail.startMs + detail.durationMs)}
                  </span>
                </p>
              </section>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {[
                  [l.model, detail.model],
                  [l.inputTokens, detail.inputTokens?.toLocaleString()],
                  [l.outputTokens, detail.outputTokens?.toLocaleString()],
                  [
                    l.cost,
                    detail.cost === undefined
                      ? undefined
                      : `$${detail.cost.toFixed(4)}`,
                  ],
                ].map(
                  ([label, value]) =>
                    value !== undefined && (
                      <div key={label} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          {label}
                        </dt>
                        <dd className="mt-0.5 truncate font-mono text-sm tabular-nums">
                          {value}
                        </dd>
                      </div>
                    ),
                )}
              </dl>
              {detail.error && (
                <p className="rounded-2xl border border-rose-500/25 bg-rose-500/10 p-3 text-xs leading-5 text-destructive">
                  {detail.error}
                </p>
              )}
              {(["input", "output"] as const).map((key) => (
                <section key={key}>
                  <h4 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                    {l[key]}
                  </h4>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-border p-3 font-mono text-xs leading-5">
                    {detail[key] ?? l.notRecorded}
                  </pre>
                </section>
              ))}
              {!!detail.attributes && (
                <section>
                  <h4 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                    {l.attributes}
                  </h4>
                  <dl className="mt-2 divide-y divide-border rounded-2xl border border-border">
                    {Object.entries(detail.attributes).map(([key, value]) => (
                      <div
                        key={key}
                        className="flex justify-between gap-3 px-3 py-2 font-mono text-xs"
                      >
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
            </aside>
          )}
        </AgentDisclosure>
      </div>
    </section>
  );
}
