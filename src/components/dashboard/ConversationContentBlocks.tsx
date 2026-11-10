"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { Bot, Brain, ChevronDown, Wrench, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { MessageTyping } from "@/components/agents/message";
import { ToolResult } from "@/components/agents/tool-result";
import { ConversationFilePreview } from "@/components/dashboard/ConversationComposer";
import {
  AssistantMarkdown,
  ToolPayload,
  toolOutputText,
  toolResultUnboundedHeight,
} from "@/components/dashboard/ConversationMessage";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { SubagentActivity } from "./agents/SubagentActivity";
import { HookActivity, HookActivitySchema } from "./agents/HookActivity";
import {
  contentProcessStatus,
  toContentBlocks,
  workContentParts,
  formatContentDuration,
  type ContentBlock,
  type ContentStep,
  type ToolBlockStatus,
} from "@/lib/conversation/content-blocks";
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
  headerExtra?: ReactNode;
  processDataTypes?: readonly `data-${string}`[];
  renderDataStep?: (
    step: Extract<ContentStep, { kind: "data" }>,
  ) => ReactNode | null;
  toolOverride?: (toolCallId: string) => ContentToolOverride | undefined;
  extraSteps?: ContentStep[];
};

type ProcessBlock = Extract<ContentBlock, { kind: "process" }>;
type ToolStep = Extract<ContentStep, { kind: "tool" }>;

function displayToolName(name: string): string {
  return name.replace(/^(?:mcp__)?tp_\d+_[A-Za-z0-9_-]+__/, "");
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

/** One-line argument hint so consecutive calls of the same tool stay distinguishable. */
function toolInputSummary(value: unknown): string | undefined {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value);
    } catch {
      return value.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  const key = SUMMARY_KEYS.find((name) => typeof record[name] === "string");
  const text =
    key !== undefined
      ? (record[key] as string)
      : Object.values(record).find((item) => typeof item === "string");
  return typeof text === "string"
    ? text.replace(/\s+/g, " ").trim().slice(0, 120) || undefined
    : undefined;
}

function ConversationThinkingStep({
  step,
}: {
  step: Extract<ContentStep, { kind: "thinking" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!step.text) return null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
      className="block w-full rounded-md py-1 text-left text-xs leading-relaxed text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={cn(
          "block whitespace-pre-wrap break-words",
          !expanded && "line-clamp-2",
        )}
      >
        {step.text}
      </span>
    </button>
  );
}

function ConversationToolStep({ step }: { step: ToolStep }) {
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
  const userToggle = useRef(false);
  // Collapsed steps skip payload formatting and code highlighting entirely.
  const input =
    !open || step.input === undefined ? undefined : formatPayload(step.input);
  const plainOutput = open ? toolOutputText(step.output) : undefined;
  const output =
    !open || step.output === undefined
      ? undefined
      : (plainOutput ?? formatPayload(step.output));
  return (
    <div
      onClickCapture={() => {
        userToggle.current = true;
        // React runs capture and bubble handlers from separate root listeners, and
        // a real click drains microtasks between them; reset after the whole event.
        setTimeout(() => {
          userToggle.current = false;
        }, 0);
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
        onOpenChange={(next) => {
          if (userToggle.current) setOpen(next);
        }}
        collapseOnComplete={false}
        maxHeight={toolResultUnboundedHeight}
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
            {output !== undefined ? (
              <ToolPayload
                label={
                  <span className="flex items-center justify-between gap-2">
                    <span>{t("toolOutput")}</span>
                    <CopyButton text={output} label={common("copy")} iconOnly />
                  </span>
                }
                language={plainOutput === undefined ? "json" : "text"}
              >
                {output}
              </ToolPayload>
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
  headerExtra,
  renderDataStep,
}: {
  block: ProcessBlock;
  activeLabel?: string;
  headerExtra?: ReactNode;
  renderDataStep?: Props["renderDataStep"];
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
  const label = currentRunning
    ? current?.kind === "tool"
      ? current.status === "awaiting"
        ? t("toolAwaiting")
        : t("usingTool", { tool: displayToolName(current.toolName) })
      : t("thinking")
    : (activeLabel ?? t("processing"));
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
        {headerExtra}
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
            {block.steps.map((step) => {
              const content =
                step.kind === "data" ? renderDataStep?.(step) : undefined;
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
                      {step.kind === "thinking" ? (
                        <ConversationThinkingStep step={step} />
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

/** One ordered display path for Assistant and Agent UI-message parts. */
export function ConversationContentBlocks({
  messageId,
  parts,
  streaming,
  activeLabel,
  headerExtra,
  processDataTypes,
  renderDataStep,
  toolOverride,
  extraSteps,
}: Props): ReactNode {
  const t = useTranslations("console.agents");
  const work = useTranslations("console.work");
  const blocks = toContentBlocks(messageId, parts, {
    streaming,
    processDataTypes,
  });
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
      {blocks.map((block, index) => {
        if (block.kind === "text")
          return block.text ? (
            <AssistantMarkdown
              key={block.id}
              text={block.text}
              streaming={block.streaming}
            />
          ) : null;
        if (block.kind === "file")
          return (
            <ConversationFilePreview
              key={block.id}
              name={block.filename ?? t("attachment")}
              url={block.url}
              mimeType={block.mediaType}
            />
          );
        return (
          <ConversationProcessBlock
            key={block.id}
            block={block}
            activeLabel={streaming ? activeLabel : undefined}
            headerExtra={
              blocks.findLastIndex((item) => item.kind === "process") === index
                ? headerExtra
                : undefined
            }
            renderDataStep={renderDataStep}
          />
        );
      })}
    </div>
  );
}

/** Work keeps its native records and timing; only their presentation is adapted. */
export function WorkContentBlocks({
  parts,
  ...props
}: Omit<Props, "processDataTypes" | "renderDataStep">) {
  const t = useTranslations("console.work");
  return (
    <ConversationContentBlocks
      {...props}
      parts={workContentParts(parts, props.streaming)}
      processDataTypes={[
        "data-subagent-activity",
        "data-hook-activity",
        "data-work-runtime",
      ]}
      renderDataStep={(step) => {
        if (step.type === "data-subagent-activity")
          return <SubagentActivity value={step.data} />;
        if (step.type === "data-hook-activity") {
          const parsed = HookActivitySchema.safeParse(step.data);
          return parsed.success ? <HookActivity value={parsed.data} /> : null;
        }
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
      }}
    />
  );
}
