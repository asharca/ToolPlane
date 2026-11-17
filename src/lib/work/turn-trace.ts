import type {
  AgentTraceRun,
  AgentTraceSpan,
} from "@/components/agents/agent-traces";
import type { AgentExecutionStage } from "@/lib/agents/execution-stages";
import {
  displayToolName,
  workToolName,
} from "@/lib/conversation/content-blocks";

type TracePart = { type: string; [key: string]: unknown };

export type WorkTraceTiming = {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  stages?: Array<{ stage: AgentExecutionStage; at: number }>;
};

export type WorkTraceNames = {
  preparing: string;
  runtime: string;
  model: string;
  firstOutput: string;
};

const PAYLOAD_CHARACTERS = 4_000;
/** Pi's own work between a tool result and the next model request (session
 * writes, compaction) is usually a few milliseconds; only visible gaps get a row. */
const RUNTIME_GAP_MS = 500;
const ROOT_ID = "turn";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function payload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? "";
    } catch {
      return undefined;
    }
  }
  return text.length > PAYLOAD_CHARACTERS
    ? `${text.slice(0, PAYLOAD_CHARACTERS)}…`
    : text;
}

function seconds(ms: number) {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * Rebuild a recorded Work turn as a span waterfall. Model calls come from the
 * execution stage transitions, tools from their own start/end records; turns
 * persisted before either was recorded return null instead of guessed offsets.
 */
export function workTurnTrace(input: {
  id: string;
  name: string;
  status: AgentTraceRun["status"];
  timing: WorkTraceTiming;
  parts: readonly TracePart[];
  modelName?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  } | null;
  names: WorkTraceNames;
}): AgentTraceRun | null {
  const start = input.timing.startedAt;
  const end =
    input.timing.completedAt ??
    (finite(input.timing.durationMs)
      ? start + input.timing.durationMs
      : undefined);
  if (end === undefined || end < start) return null;
  const offset = (at: number) => Math.min(end, Math.max(start, at)) - start;
  // The executor may republish its current stage; a repeat is not a new segment.
  const marks = (input.timing.stages ?? [])
    .filter((mark) => finite(mark.at))
    .sort((a, b) => a.at - b.at)
    .filter((mark, index, all) => mark.stage !== all[index - 1]?.stage);
  const tools = input.parts.filter(
    (part) =>
      (part.type === "work-tool" || part.type === "tool") &&
      typeof part.toolCallId === "string" &&
      finite(part.startedAt),
  );
  if (!marks.length && !tools.length) return null;

  const spans: AgentTraceSpan[] = [];
  const toolSpans = new Map<string, AgentTraceSpan>();
  for (const part of tools) {
    const toolCallId = part.toolCallId as string;
    const startedAt = part.startedAt as number;
    const completedAt = finite(part.completedAt)
      ? part.completedAt
      : finite(part.durationMs)
        ? startedAt + part.durationMs
        : end;
    const failed = part.isError === true || part.status === "failed";
    const toolInput = payload(part.input);
    const output = payload(part.output);
    const span: AgentTraceSpan = {
      id: `tool:${toolCallId}`,
      name: displayToolName(workToolName(part)),
      kind: "tool",
      startMs: offset(startedAt),
      durationMs: Math.max(0, offset(completedAt) - offset(startedAt)),
      status: failed
        ? "failed"
        : part.status === "cancelled"
          ? "cancelled"
          : part.status === "running"
            ? "running"
            : "completed",
      ...(toolInput === undefined ? {} : { input: toolInput }),
      ...(failed ? { error: output } : output ? { output } : {}),
    };
    toolSpans.set(toolCallId, span);
    spans.push(span);
  }
  // Delegated work nests under the tool call that started it.
  for (const part of tools) {
    const source = part.source as { parentToolCallId?: unknown } | undefined;
    const span = toolSpans.get(part.toolCallId as string);
    const parent =
      typeof source?.parentToolCallId === "string"
        ? toolSpans.get(source.parentToolCallId)
        : undefined;
    if (span) span.parentId = parent && parent !== span ? parent.id : ROOT_ID;
  }
  const coveringTool = (at: number) =>
    [...toolSpans.values()]
      .filter(
        (span) =>
          span.parentId === ROOT_ID &&
          span.startMs <= at &&
          at < span.startMs + span.durationMs,
      )
      .at(-1);

  const segments = marks.map((mark, index) => ({
    stage: mark.stage,
    from: offset(mark.at),
    to: offset(marks[index + 1]?.at ?? end),
  }));
  const firstModel = segments.findIndex(
    (segment) => segment.stage === "waiting-model",
  );
  const preparedAt =
    firstModel >= 0
      ? segments[firstModel].from
      : Math.min(...spans.map((span) => span.startMs), end - start);
  if (preparedAt > 0)
    spans.push({
      id: "preparing",
      parentId: ROOT_ID,
      name: input.names.preparing,
      kind: "runtime",
      startMs: 0,
      durationMs: preparedAt,
      status: "completed",
    });

  const writing = input.parts.filter(
    (part) =>
      (part.type === "reasoning" || part.type === "text") &&
      !part.source &&
      typeof part.text === "string" &&
      part.text.trim() &&
      finite(part.startedAt),
  );
  let modelIndex = 0;
  for (let index = Math.max(0, firstModel); index < segments.length; index++) {
    const segment = segments[index];
    if (segment.stage === "preparing" && index > firstModel) {
      if (segment.to - segment.from >= RUNTIME_GAP_MS)
        spans.push({
          id: `runtime:${index}`,
          parentId: ROOT_ID,
          name: input.names.runtime,
          kind: "runtime",
          startMs: segment.from,
          durationMs: segment.to - segment.from,
          status: "completed",
        });
      continue;
    }
    if (segment.stage !== "waiting-model") continue;
    let last = index;
    while (segments[last + 1]?.stage === "generating") last++;
    const from = segment.from;
    const to = segments[last].to;
    const firstOutput = last > index ? segments[index + 1].from : undefined;
    const output = payload(
      writing
        .filter((part) => {
          const at = offset(part.startedAt as number);
          return at >= from && at < to;
        })
        .map((part) => (part.text as string).trim())
        .join("\n\n"),
    );
    const parent = coveringTool(from);
    spans.push({
      id: `model:${++modelIndex}`,
      parentId: parent?.id ?? ROOT_ID,
      name: input.modelName || input.names.model,
      kind: "llm",
      startMs: from,
      durationMs: to - from,
      status: "completed",
      ...(input.modelName ? { model: input.modelName } : {}),
      ...(output ? { output } : {}),
      ...(firstOutput === undefined
        ? {}
        : {
            attributes: {
              [input.names.firstOutput]: seconds(firstOutput - from),
            },
          }),
    });
    index = last;
  }

  spans.sort((a, b) => a.startMs - b.startMs);
  const total = end - start;
  const cost = finite(input.usage?.costUsd) ? input.usage?.costUsd : undefined;
  return {
    id: input.id,
    name: input.name,
    status: input.status,
    startedAt: new Date(start).toISOString(),
    durationMs: total,
    ...(cost === undefined ? {} : { cost, currency: "USD" }),
    spans: [
      {
        id: ROOT_ID,
        name: input.name,
        kind: "agent",
        startMs: 0,
        durationMs: total,
        status: input.status,
        ...(input.modelName ? { model: input.modelName } : {}),
        ...(input.usage
          ? {
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
            }
          : {}),
        ...(cost === undefined ? {} : { cost }),
      },
      ...spans,
    ],
  };
}
