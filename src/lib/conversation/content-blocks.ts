import type { StreamRuleTrigger } from "@/lib/agents/stream-rules";
import type { ContextMaintenance } from "@/lib/agents/context-maintenance";
import { ADVISOR_SUGGESTIONS_PART } from "@/lib/agents/advisor";

/**
 * The conversation content model. `projectContent` in `./content-projection`
 * is its only producer; every consumer (console renderer, Markdown export)
 * switches exhaustively over `ContentBlock`, `ContentStep` and
 * `ProcessDataType`, so a new variant fails the type check until each surface
 * handles it.
 */
export const PROCESS_DATA_TYPES = [
  "data-subagent-activity",
  "data-hook-activity",
  "data-work-runtime",
  ADVISOR_SUGGESTIONS_PART,
] as const;
export type ProcessDataType = (typeof PROCESS_DATA_TYPES)[number];

export function isProcessDataType(type: string): type is ProcessDataType {
  return (PROCESS_DATA_TYPES as readonly string[]).includes(type);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled conversation content: ${JSON.stringify(value)}`);
}

export type ToolBlockStatus =
  | "running"
  | "awaiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ContentStep =
  | {
      kind: "thinking";
      id: string;
      text: string;
      streaming: boolean;
      durationMs?: number;
    }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      status: ToolBlockStatus;
      input?: unknown;
      output?: unknown;
      patch?: string;
      truncated?: boolean;
      firstChangedLine?: number;
      errorText?: string;
      durationMs?: number;
      /** Failed outside the model's view (e.g. a confirmed execution receipt). */
      platformFailure?: boolean;
    }
  | {
      kind: "data";
      id: string;
      partIndex: number;
      type: ProcessDataType;
      data: unknown;
    };

export type ContentBlock =
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | { kind: "stream-rule"; id: string; trigger: StreamRuleTrigger }
  | { kind: "context-maintenance"; id: string; data: ContextMaintenance }
  | {
      kind: "process";
      id: string;
      status: "working" | "complete" | "failed" | "cancelled";
      steps: ContentStep[];
    }
  | {
      kind: "file";
      id: string;
      partIndex: number;
      url: string;
      filename?: string;
      mediaType: string;
    };

type ProcessStatus = Extract<ContentBlock, { kind: "process" }>["status"];

function dataStatus(data: unknown): ToolBlockStatus | undefined {
  if (!data || typeof data !== "object") return;
  const value = data as Record<string, unknown>;
  if (
    value.isError === true ||
    value.status === "failed" ||
    value.status === "timed_out"
  )
    return "failed";
  if (value.status === "cancelled" || value.result === "cancelled")
    return "cancelled";
  if (value.status === "running" || value.status === "working")
    return "running";
  return;
}

/** Recalculate after display-only receipt overrides or appended process steps. */
export function contentProcessStatus(
  steps: readonly ContentStep[],
  streaming: boolean,
  current = streaming,
): ProcessStatus {
  let cancelled = false;
  let pending = false;
  let awaiting = false;
  for (const step of steps) {
    const status =
      step.kind === "tool"
        ? step.status
        : step.kind === "data"
          ? dataStatus(step.data)
          : undefined;
    // Tool errors are results the model reads and handles (including a subagent's
    // tool); only runtime or platform-level failures fail the whole process.
    const modelResult =
      (step.kind === "tool" && !step.platformFailure) ||
      (step.kind === "data" &&
        (step.data as { type?: unknown } | null)?.type === "tool");
    if (status === "failed" && !modelResult) return "failed";
    if (status === "cancelled") cancelled = true;
    if (status === "running" || status === "awaiting") pending = true;
    if (status === "awaiting") awaiting = true;
  }
  if (awaiting || (streaming && (pending || (current && !cancelled))))
    return "working";
  if (cancelled || pending) return "cancelled";
  return "complete";
}

export function displayToolName(name: string): string {
  return name.replace(/^(?:mcp__)?tp_\d+_[A-Za-z0-9_-]+__/, "");
}

/** A Work tool record's label: the MCP server and its own tool name when known. */
export function workToolName(part: Readonly<Record<string, unknown>>): string {
  if (
    typeof part.deploymentName === "string" &&
    part.deploymentName &&
    typeof part.originalToolName === "string" &&
    part.originalToolName
  )
    return `${part.deploymentName} · ${part.originalToolName}`;
  if (typeof part.originalToolName === "string" && part.originalToolName)
    return part.originalToolName;
  return typeof part.toolName === "string" && part.toolName
    ? part.toolName
    : "Tool";
}

/** Live Work output streams text separately from activities; each activity
 * records the text length when it began, so the reply can be read in order.
 */
export function interleaveLiveText<
  T extends { type: string; textOffset?: number },
>(
  activities: readonly T[],
  text: string,
): Array<T | { type: "text"; text: string }> {
  const parts: Array<T | { type: "text"; text: string }> = [];
  let cursor = 0;
  for (const activity of activities) {
    const offset =
      typeof activity.textOffset === "number" &&
      Number.isFinite(activity.textOffset)
        ? Math.min(Math.max(activity.textOffset, cursor), text.length)
        : cursor;
    const segment = text.slice(cursor, offset);
    if (segment.trim()) parts.push({ type: "text", text: segment });
    cursor = offset;
    parts.push(activity);
  }
  const rest = text.slice(cursor);
  if (rest.trim()) parts.push({ type: "text", text: rest });
  return parts;
}

export type ReasoningOutline = {
  /** Heading above the prose. */
  title?: string;
  /** Newest heading anywhere in the text: what the model is doing now. */
  latestTitle?: string;
  /** Prose and any later sections beneath the heading. */
  body: string;
};

const REASONING_TITLE = /^\*\*(.+?)\*\*[ \t]*$/;
const OPEN_REASONING_TITLE = /^\*\*[^*]*\*?$/;

/**
 * Reasoning summaries (e.g. OpenAI Responses) are `**Title**` lines with optional
 * prose beneath; often the titles are all there is. Bare headings ahead of any
 * prose supersede one another. While streaming, the newest line may be a title
 * whose closing marker has not arrived yet.
 */
export function splitReasoning(
  text: string,
  streaming = false,
): ReasoningOutline {
  const lines = text.trim().split(/\r?\n/);
  const last = lines.length - 1;
  const openTail = streaming && OPEN_REASONING_TITLE.test(lines[last]);
  const titleAt = (index: number): string | undefined =>
    openTail && index === last
      ? lines[index].replace(/^\*\*|\*$/g, "").trim()
      : REASONING_TITLE.exec(lines[index])?.[1].trim();
  let title: string | undefined;
  let start = 0;
  for (; start <= last; start++) {
    if (!lines[start].trim()) continue;
    const found = titleAt(start);
    if (found === undefined) break;
    title = found || title;
  }
  let latestTitle = title;
  for (let index = last; index >= start; index--) {
    const found = titleAt(index);
    if (found) {
      latestTitle = found;
      break;
    }
  }
  return {
    title,
    latestTitle,
    body: lines
      .slice(start, openTail && start <= last ? last : undefined)
      .join("\n")
      .trim(),
  };
}

export function formatContentDuration(
  durationMs: number | undefined,
): string | null {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}
