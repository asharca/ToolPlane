"use client";

import { useMemo, useState, type ReactElement } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  TraceWaterfall,
  type AgentTraceRun,
  type TraceWaterfallLabels,
} from "@/components/agents/agent-traces";
import {
  CenterMorphModal,
  CenterMorphModalContent,
  CenterMorphModalTrigger,
} from "@/components/motion/center-morph-modal";
import { formatContentDuration } from "@/lib/conversation/content-blocks";
import {
  parseRuntimeUsage,
  RUNTIME_USAGE_PART,
} from "@/lib/agents/runtime-commands";
import { workTurnTrace, type WorkTraceTiming } from "@/lib/work/turn-trace";

type Part = { type: string; [key: string]: unknown };

/** The reply's total time; opening it shows where that time went. */
export function WorkTurnTrace({
  messageId,
  timing,
  durationMs,
  parts,
  modelName,
  status,
  children,
}: {
  messageId: string;
  timing: WorkTraceTiming;
  /** Displayed total, already excluding approval waits. */
  durationMs: number;
  parts: readonly Part[];
  modelName?: string | null;
  status: AgentTraceRun["status"];
  children: ReactElement;
}) {
  const t = useTranslations("console.work.trace");
  const agentsT = useTranslations("console.agents");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  // Built on first open and kept, so the surface keeps its content while folding away.
  const [visited, setVisited] = useState(false);
  const labels = useMemo<Partial<TraceWaterfallLabels>>(
    () => ({
      trace: (name) => t("trace", { name }),
      status: {
        completed: t("completed"),
        failed: t("failed"),
        running: t("running"),
        cancelled: t("cancelled"),
      },
      retries: (count) => t("retries", { count }),
      duration: t("duration"),
      spans: t("spans"),
      tokens: t("tokens"),
      cost: t("cost"),
      showKinds: t("showKinds"),
      kinds: {
        agent: t("kindAgent"),
        llm: t("kindLlm"),
        tool: t("kindTool"),
        runtime: t("kindRuntime"),
      },
      span: t("span"),
      expand: (name) => t("expand", { name }),
      collapse: (name) => t("collapse", { name }),
      expandAll: t("expandAll"),
      collapseAll: t("collapseAll"),
      search: t("search"),
      clearSearch: t("clearSearch"),
      errorsOnly: t("errorsOnly"),
      zoomIn: t("zoomIn"),
      zoomOut: t("zoomOut"),
      zoomReset: t("zoomReset"),
      previousSpan: t("previousSpan"),
      nextSpan: t("nextSpan"),
      shareOfTotal: t("shareOfTotal"),
      copy: t("copy"),
      copied: t("copied"),
      expandText: t("expandText"),
      collapseText: t("collapseText"),
      noSpans: t("noSpans"),
      noMatches: t("noMatches"),
      resetFilters: t("resetFilters"),
      clearSelection: t("clearSelection"),
      timing: t("timing"),
      start: t("start"),
      end: t("end"),
      model: t("model"),
      inputTokens: t("inputTokens"),
      outputTokens: t("outputTokens"),
      input: t("input"),
      output: t("output"),
      notRecorded: t("notRecorded"),
      attributes: t("attributes"),
      startedAt: (value) =>
        format.dateTime(new Date(value), {
          dateStyle: "medium",
          timeStyle: "medium",
        }),
    }),
    [format, t],
  );
  const run = useMemo(() => {
    if (!visited) return null;
    const usagePart = parts.findLast(
      (part) => part.type === RUNTIME_USAGE_PART,
    );
    return workTurnTrace({
      id: messageId,
      name: t("turn"),
      status,
      timing,
      parts,
      modelName,
      usage: parseRuntimeUsage(usagePart?.data),
      names: {
        preparing: t("preparing"),
        runtime: t("runtime"),
        model: t("model"),
        firstOutput: t("firstOutput"),
      },
    });
  }, [messageId, modelName, visited, parts, status, t, timing]);
  const toolTime = useMemo(() => {
    if (!visited || run) return null;
    let total = 0;
    let count = 0;
    for (const part of parts) {
      if (part.type !== "work-tool" && part.type !== "tool") continue;
      count += 1;
      if (typeof part.durationMs === "number" && part.durationMs >= 0)
        total += part.durationMs;
    }
    return { total, count };
  }, [visited, parts, run]);
  return (
    <CenterMorphModal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setVisited(true);
      }}
    >
      <CenterMorphModalTrigger>
        <button
          type="button"
          title={t("open")}
          aria-label={t("open")}
          className="rounded-sm underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {children}
        </button>
      </CenterMorphModalTrigger>
      <CenterMorphModalContent
        ariaLabel={t("open")}
        closeButtonLabel={agentsT("close")}
        className={
          run
            ? run.spans.length > 6
              ? "flex h-[min(52rem,calc(100dvh-2rem))] w-full max-w-6xl flex-col overflow-hidden"
              : "flex min-h-[min(28rem,calc(100dvh-2rem))] max-h-[min(52rem,calc(100dvh-2rem))] w-full max-w-6xl flex-col overflow-hidden"
            : "max-w-lg"
        }
      >
        {run ? (
          <TraceWaterfall
            run={run}
            labels={labels}
            className="min-h-0 flex-1 max-w-none rounded-none border-0"
          />
        ) : toolTime ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-6 pt-14 text-sm">
            <dl className="grid grid-cols-3 gap-4">
              {[
                [t("total"), durationMs],
                [t("tools", { count: toolTime.count }), toolTime.total],
                [t("other"), Math.max(0, durationMs - toolTime.total)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="mb-1 text-xs text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="font-mono text-lg tabular-nums">
                    {formatContentDuration(value as number)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">{t("untracked")}</p>
          </div>
        ) : null}
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
