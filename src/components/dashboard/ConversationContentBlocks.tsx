"use client";

import { useAgentUiLabels } from "./agent-ui-labels";
import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  Brain,
  ChevronDown,
  FileText,
  Undo2,
  Wrench,
  Zap,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { MessageTyping } from "@/components/agents/message";
import { ToolResult } from "@/components/agents/tool-result";
import { ConversationFilePreview } from "@/components/dashboard/ConversationComposer";
import {
  AssistantMarkdown,
  assistantCodeRenderers,
  StreamRuleNotice,
  ToolPayload,
  toolResultUnboundedHeight,
} from "@/components/dashboard/ConversationMessage";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import { ConversationToolDiff } from "./ConversationToolDiff";
import { ConversationToolOutput } from "@/components/dashboard/ConversationToolOutput";
import { SubagentActivity } from "./agents/SubagentActivity";
import { HookActivity, HookActivitySchema } from "./agents/HookActivity";
import { AdvisorSuggestionsCard } from "./agents/AdvisorSuggestionsCard";
import {
  ADVISOR_SUGGESTIONS_PART,
  AdvisorSuggestionsSchema,
} from "@/lib/agents/advisor";
import {
  assertNever,
  contentProcessStatus,
  displayToolName,
  splitReasoning,
  formatContentDuration,
  type ContentBlock,
  type ContentStep,
  type ReasoningOutline,
  type ToolBlockStatus,
} from "@/lib/conversation/content-blocks";
import { projectContent } from "@/lib/conversation/content-projection";
import { cn } from "@/lib/utils";

export type ContentToolOverride = {
  status?: ToolBlockStatus;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  platformFailure?: boolean;
};

type Props = {
  messageId: string;
  parts: readonly { type: string; [key: string]: unknown }[];
  streaming: boolean;
  activeLabel?: string;
  toolOverride?: (toolCallId: string) => ContentToolOverride | undefined;
  extraSteps?: ContentStep[];
};

type ProcessBlock = Extract<ContentBlock, { kind: "process" }>;
type ToolStep = Extract<ContentStep, { kind: "tool" }>;
type DataStep = Extract<ContentStep, { kind: "data" }>;

/** Null when the record does not parse; the step then gets no row. */
function dataStepContent(
  step: DataStep,
  t: ReturnType<typeof useTranslations<"console.work">>,
): ReactNode | null {
  switch (step.type) {
    case ADVISOR_SUGGESTIONS_PART: {
      const parsed = AdvisorSuggestionsSchema.safeParse(step.data);
      return parsed.success ? (
        <AdvisorSuggestionsCard advisory={parsed.data} />
      ) : null;
    }
    case "data-subagent-activity":
      return <SubagentActivity value={step.data} />;
    case "data-hook-activity": {
      const parsed = HookActivitySchema.safeParse(step.data);
      return parsed.success ? <HookActivity value={parsed.data} /> : null;
    }
    case "data-work-runtime": {
      const data = step.data as {
        runtimeKind?: string;
        status?: string;
        text?: string;
      };
      const runtime =
        data.runtimeKind === "pi-sdk" || data.runtimeKind === "pi"
          ? "Pi"
          : data.runtimeKind === "omp"
            ? "OMP"
            : data.runtimeKind === "claude-code"
              ? "Claude Code"
              : data.runtimeKind === "dsh"
                ? "DeepSeek Harness"
                : "—";
      return (
        <p className="text-xs text-muted-foreground">
          {data.status === "cancelled"
            ? t("runtimeCancelled", { runtime })
            : (data.text ?? runtime)}
        </p>
      );
    }
    default:
      return assertNever(step.type);
  }
}

/** Tool payloads may already be serialized JSON; pretty-print instead of re-quoting. */
function formatPayload(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value, null, 2) ?? "";
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object"
      ? JSON.stringify(parsed, null, 2)
      : value;
  } catch {
    return value;
  }
}

const SUMMARY_KEYS = [
  "command",
  "cmd",
  "query",
  "q",
  "path",
  "file_path",
  "filePath",
  "url",
  "pattern",
  "name",
] as const;

const PATH_KEYS: ReadonlySet<string> = new Set([
  "path",
  "file_path",
  "filePath",
]);
const SUMMARY_LENGTH = 120;
const PATH_SUMMARY_LENGTH = 72;
// A session's working directory and the pinned runtime directory beneath it are
// platform plumbing: over 100 characters ahead of the part that tells calls apart.
const SESSION_ROOT =
  /\/workspace\/conversations\/(?:conversation|context)-[0-9a-f]{64}(?:\/(?=\S))?/g;
const RUNTIME_ROOT =
  /\.toolplane\/runtimes\/[^/\s]+\/agents\/[^/\s]+\/(?:revisions\/[^/\s]+\/)?/g;

function summaryText(value: string, path: boolean): string | undefined {
  const text = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(SESSION_ROOT, (root) => (root.endsWith("/") ? "" : "."))
    .replace(RUNTIME_ROOT, "…/");
  if (!path || text.length <= PATH_SUMMARY_LENGTH)
    return text.slice(0, SUMMARY_LENGTH) || undefined;
  // The file name is what distinguishes one path from the next.
  return `${text.slice(0, 20)}…${text.slice(21 - PATH_SUMMARY_LENGTH)}`;
}

/** One-line argument hint so consecutive calls of the same tool stay distinguishable. */
export function toolInputSummary(value: unknown): string | undefined {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value);
    } catch {
      return summaryText(value, false);
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  const key = SUMMARY_KEYS.find((name) => typeof record[name] === "string");
  const text =
    key !== undefined
      ? record[key]
      : Object.values(record).find((item) => typeof item === "string");
  return typeof text === "string"
    ? summaryText(text, key !== undefined && PATH_KEYS.has(key))
    : undefined;
}

type ThinkingStep = Extract<ContentStep, { kind: "thinking" }>;
type TimelineStep =
  | { step: Exclude<ContentStep, ThinkingStep> }
  | { step: ThinkingStep; reasoning: ReasoningOutline };

/** Empty reasoning slots carry nothing, and a bare heading directly followed by
 * more reasoning was only a passing status; neither gets a row. */
function timelineSteps(steps: readonly ContentStep[]): TimelineStep[] {
  const shown: TimelineStep[] = [];
  let beforeReasoning = false;
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step.kind !== "thinking") {
      shown.push({ step });
      beforeReasoning = false;
      continue;
    }
    const reasoning = splitReasoning(step.text, step.streaming);
    if (!reasoning.body && (!reasoning.title || beforeReasoning)) continue;
    shown.push({ step, reasoning });
    beforeReasoning = true;
  }
  return shown.reverse();
}

/** The newest reasoning heading stays the status while its tools run. */
function liveReasoningTitle(steps: readonly ContentStep[]): string | undefined {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step.kind === "tool") continue;
    if (step.kind !== "thinking") return;
    if (step.text.trim())
      return splitReasoning(step.text, step.streaming).latestTitle;
  }
  return;
}

function ConversationThinkingStep({
  reasoning: { title, body },
  streaming,
  durationMs,
}: {
  reasoning: ReasoningOutline;
  streaming: boolean;
  durationMs?: number;
}) {
  const t = useTranslations("console.work");
  const [expanded, setExpanded] = useState(false);
  const renderers = useMemo(
    () => (expanded ? assistantCodeRenderers(body) : undefined),
    [expanded, body],
  );
  const duration = formatContentDuration(durationMs);
  const durationLabel = duration ? (
    <span className="shrink-0 font-normal tabular-nums opacity-70">
      {duration}
    </span>
  ) : null;
  if (!body)
    return (
      <div className="flex items-baseline gap-2 py-1 text-xs font-medium leading-relaxed text-muted-foreground">
        <span className="min-w-0">{title}</span>
        {durationLabel}
      </div>
    );
  const heading =
    title ??
    (expanded || duration ? t(streaming ? "thinking" : "thought") : undefined);
  const previewText = body
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  return (
    <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex w-full items-start justify-between gap-2 rounded-md py-1 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          {heading ? (
            <span className="flex items-baseline gap-2 font-medium">
              <span className="min-w-0">{heading}</span>
              {durationLabel}
            </span>
          ) : null}
          {expanded ? null : (
            <span className="line-clamp-2 whitespace-pre-wrap break-words">
              {previewText}
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-3.5 shrink-0 opacity-70 transition-transform group-hover:opacity-100 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="min-w-0 break-words pb-1 [&_:not(pre)>code]:text-[0.95em] [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_strong]:font-medium [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
          <SafeStreamdown
            assistant
            mode="static"
            plugins={{ renderers }}
            preserveSoftBreaks
            linkSafety={{ enabled: true }}
          >
            {body}
          </SafeStreamdown>
        </div>
      ) : null}
    </div>
  );
}

function ConversationToolStep({ step }: { step: ToolStep }) {
  const agentUi = useAgentUiLabels();
  const t = useTranslations("console.agents");
  const work = useTranslations("console.work");
  const common = useTranslations("common");
  // Only the reader opens or closes a step; status changes never resize the transcript.
  // Model-visible tool errors are ordinary results, so only approvals and
  // platform-level failures start open.
  const [open, setOpen] = useState(
    step.status === "awaiting" ||
      (step.status === "failed" && step.platformFailure === true),
  );
  const hasPatch = typeof step.patch === "string" && step.patch.length > 0;
  // Collapsed steps skip payload formatting and code highlighting entirely.
  const input =
    !open || step.input === undefined ? undefined : formatPayload(step.input);
  return (
    // ToolResult is controlled without onOpenChange, so its status-driven
    // opens are ignored; only a click on its own header button toggles.
    <div
      onClickCapture={(event) => {
        const trigger = (event.target as Element).closest("button");
        if (trigger?.parentElement?.parentElement === event.currentTarget)
          setOpen((value) => !value);
      }}
    >
      <ToolResult
        tool={toolInputSummary(step.input)}
        title={displayToolName(step.toolName)}
        icon={<Wrench className="size-4" />}
        status={
          step.status === "succeeded"
            ? "success"
            : step.status === "failed"
              ? "error"
              : step.status === "cancelled"
                ? "cancelled"
                : "running"
        }
        meta={
          formatContentDuration(step.durationMs) ??
          (step.status === "awaiting" ? work("toolAwaiting") : undefined)
        }
        open={open}
        collapseOnComplete={false}
        maxHeight={toolResultUnboundedHeight}
        labels={agentUi.toolResult}
      >
        {open ? (
          <div className="space-y-3">
            {input !== undefined ? (
              <ToolPayload
                label={
                  <span className="flex items-center justify-between gap-2">
                    <span>{t("toolInput")}</span>
                    <CopyButton text={input} label={common("copy")} iconOnly />
                  </span>
                }
                language="json"
              >
                {input}
              </ToolPayload>
            ) : null}
            {step.patch ? (
              <ConversationToolDiff
                patch={step.patch}
                truncated={step.truncated}
                firstChangedLine={step.firstChangedLine}
              />
            ) : null}
            {step.output !== undefined &&
            (!hasPatch || step.status === "failed") ? (
              <ConversationToolOutput
                value={step.output}
                label={t("toolOutput")}
              />
            ) : null}
            {step.errorText ? (
              <p
                role="alert"
                className="whitespace-pre-wrap text-sm text-destructive"
              >
                {step.errorText}
              </p>
            ) : null}
          </div>
        ) : null}
      </ToolResult>
    </div>
  );
}

function ConversationProcessBlock({
  block,
  activeLabel,
}: {
  block: ProcessBlock;
  activeLabel?: string;
}) {
  const t = useTranslations("console.work");
  const id = useId();
  const working = block.status === "working";
  const [open, setOpen] = useState(
    block.status === "failed" || block.status === "cancelled",
  );
  // Steps mount on first open and then keep their own disclosure state.
  const [visited, setVisited] = useState(open);
  const toolCount = block.steps.filter((step) => step.kind === "tool").length;
  const current = block.steps.at(-1);
  const currentRunning =
    working &&
    ((current?.kind === "tool" &&
      (current.status === "running" || current.status === "awaiting")) ||
      (current?.kind === "thinking" && current.streaming));
  const label =
    current?.kind === "tool" && current.status === "awaiting"
      ? t("toolAwaiting")
      : ((working ? liveReasoningTitle(block.steps) : undefined) ??
        (currentRunning
          ? current?.kind === "tool"
            ? t("usingTool", { tool: displayToolName(current.toolName) })
            : t("thinking")
          : (activeLabel ?? t("processing"))));
  const summary =
    block.status === "failed"
      ? t("processFailed")
      : block.status === "cancelled"
        ? t("processCancelled")
        : toolCount
          ? t("toolsUsed", { count: toolCount })
          : block.steps.every((step) => step.kind === "thinking")
            ? t("thought")
            : t("processed");
  // Advisor-only messages are visible records, not a collapsed execution summary.
  if (
    block.steps.every(
      (step) => step.kind === "data" && step.type === ADVISOR_SUGGESTIONS_PART,
    )
  ) {
    return (
      <div className="space-y-3">
        {block.steps.map((step) =>
          step.kind === "data" ? (
            <div key={step.id}>{dataStepContent(step, t)}</div>
          ) : null,
        )}
      </div>
    );
  }
  return (
    <div
      data-ui="conversation-process"
      data-state={block.status}
      aria-busy={working}
      className="w-full min-w-0"
    >
      <button
        id={`${id}-trigger`}
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-content`}
        onClick={() => {
          setOpen((value) => !value);
          setVisited(true);
        }}
        className="group flex min-h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="min-w-0 truncate">
          {working ? <ThinkingShimmer>{label}</ThinkingShimmer> : summary}
        </span>
        {block.steps.length > 1 && (working || !toolCount) ? (
          <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground/70">
            ({block.steps.length})
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <AgentDisclosure
        id={`${id}-content`}
        role="region"
        aria-labelledby={`${id}-trigger`}
        open={open}
      >
        {visited ? (
          <ul className="m-0! list-none! space-y-1 p-0! py-2!">
            {timelineSteps(block.steps).map((item) => {
              const { step } = item;
              const content =
                step.kind === "data" ? dataStepContent(step, t) : undefined;
              if (step.kind === "data" && content == null) return null;
              return (
                <li
                  key={step.id}
                  className="relative ml-2 min-w-0 list-none! border-l border-border/60 pb-2 pl-4 last:pb-0"
                >
                  {step.kind === "tool" ? (
                    <ConversationToolStep step={step} />
                  ) : (
                    <>
                      <span
                        aria-hidden="true"
                        className="absolute -left-2 top-1.5 grid size-4 place-items-center bg-background text-muted-foreground"
                      >
                        {step.kind === "thinking" ? (
                          <Brain className="size-3.5" />
                        ) : step.type === "data-subagent-activity" ? (
                          <Bot className="size-3.5" />
                        ) : (
                          <Zap className="size-3.5" />
                        )}
                      </span>
                      {"reasoning" in item ? (
                        <ConversationThinkingStep
                          reasoning={item.reasoning}
                          streaming={item.step.streaming}
                          durationMs={item.step.durationMs}
                        />
                      ) : (
                        content
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </AgentDisclosure>
    </div>
  );
}

function ContextMaintenanceBlock({
  block,
}: {
  block: Extract<ContentBlock, { kind: "context-maintenance" }>;
}) {
  const t = useTranslations("console.conversationOperations");
  const format = useFormatter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const rewind = block.data.kind === "rewind";
  const Icon = rewind ? Undo2 : FileText;
  return (
    <div
      data-ui="conversation.context-maintenance"
      data-kind={block.data.kind}
      className="min-w-0 border-y border-border py-2 text-xs text-muted-foreground"
    >
      <button
        id={`${id}-trigger`}
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-content`}
        onClick={() => {
          setOpen((value) => !value);
          setVisited(true);
        }}
        className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{t(rewind ? "contextRewound" : "contextHandedOff")}</span>
        <time dateTime={block.data.at}>
          {format.dateTime(new Date(block.data.at), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </time>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <AgentDisclosure
        id={`${id}-content`}
        role="region"
        aria-labelledby={`${id}-trigger ${id}-label`}
        open={open}
      >
        <span id={`${id}-label`} className="sr-only">
          {t(rewind ? "contextMaintenanceReport" : "contextMaintenanceSummary")}
        </span>
        {visited ? (
          <div className="min-w-0 break-words pt-3 text-foreground">
            <AssistantMarkdown
              text={
                block.data.kind === "rewind"
                  ? block.data.report
                  : block.data.summary
              }
            />
          </div>
        ) : null}
      </AgentDisclosure>
    </div>
  );
}

/** One ordered display path for Assistant, Agent and Work UI-message parts. */
export function ConversationContentBlocks({
  messageId,
  parts,
  streaming,
  activeLabel,
  toolOverride,
  extraSteps,
}: Props): ReactNode {
  const t = useTranslations("console.agents");
  const work = useTranslations("console.work");
  const blocks = projectContent(messageId, parts, { streaming });
  for (const block of blocks) {
    if (block.kind !== "process") continue;
    block.steps = block.steps.map((step) => {
      if (step.kind !== "tool") return step;
      const override = toolOverride?.(step.toolCallId);
      return override ? { ...step, ...override } : step;
    });
  }
  if (extraSteps?.length) {
    const process = blocks.findLast((block) => block.kind === "process");
    if (process?.kind === "process") process.steps.push(...extraSteps);
    else
      blocks.push({
        kind: "process",
        id: `${messageId}:process:receipts`,
        status: "complete",
        steps: [...extraSteps],
      });
  }
  blocks.forEach((block, index) => {
    if (block.kind === "text") {
      block.streaming &&= index === blocks.length - 1;
      return;
    }
    if (block.kind !== "process") return;
    block.status = contentProcessStatus(
      block.steps,
      streaming,
      index === blocks.length - 1,
    );
  });
  const hasContent = blocks.some(
    (block) => block.kind !== "text" || block.text.length > 0,
  );
  if (!hasContent && streaming)
    return (
      <div role="status" className="py-1 text-sm text-muted-foreground">
        {activeLabel ? (
          <ThinkingShimmer>{activeLabel}</ThinkingShimmer>
        ) : (
          <MessageTyping label={work("generatingReply")} />
        )}
      </div>
    );
  return (
    <div className="w-full min-w-0 space-y-3">
      {blocks.map((block) => {
        switch (block.kind) {
          case "stream-rule":
            return <StreamRuleNotice key={block.id} trigger={block.trigger} />;
          case "text":
            return block.text ? (
              <AssistantMarkdown
                key={block.id}
                text={block.text}
                streaming={block.streaming}
              />
            ) : null;
          case "context-maintenance":
            return <ContextMaintenanceBlock key={block.id} block={block} />;
          case "file":
            return (
              <ConversationFilePreview
                key={block.id}
                name={block.filename ?? t("attachment")}
                url={block.url}
                mimeType={block.mediaType}
                producer={block.producer}
                size={block.size}
                display="inline"
              />
            );
          case "process":
            return (
              <ConversationProcessBlock
                key={block.id}
                block={block}
                activeLabel={streaming ? activeLabel : undefined}
              />
            );
          default:
            return assertNever(block);
        }
      })}
    </div>
  );
}
