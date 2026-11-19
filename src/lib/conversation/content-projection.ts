import {
  CONTEXT_MAINTENANCE_PART,
  ContextMaintenanceSchema,
} from "@/lib/agents/context-maintenance";
import {
  STREAM_RULE_TRIGGER_PART,
  StreamRuleTriggerSchema,
  type StreamRuleTrigger,
} from "@/lib/agents/stream-rules";
import { agentTimelineDisplayParts } from "@/lib/agents/turn-timeline";
import {
  assertNever,
  contentProcessStatus,
  interleaveLiveText,
  isProcessDataType,
  workToolName,
  type ContentBlock,
  type ContentStep,
  type ToolBlockStatus,
} from "./content-blocks";

/**
 * The one projection from conversation parts to display content. Persisted
 * Work records, Agent chat UI-message parts, recorded turn timelines and live
 * Work output all pass through here, so the console, every entry that renders
 * a conversation and the Markdown export show the same blocks.
 */

type Part = { type: string; [key: string]: unknown };

const OMITTED: Part = { type: "omitted" };

function toolStatus(state: unknown, streaming: boolean): ToolBlockStatus {
  switch (state) {
    case "approval-requested":
      return "awaiting";
    case "output-available":
      return "succeeded";
    case "output-error":
    case "output-denied":
      return "failed";
    default:
      return streaming ? "running" : "cancelled";
  }
}

/** Work's own records: persisted Work parts, live activities, timeline steps. */
function isWorkRecord(part: Part): boolean {
  switch (part.type) {
    case "work-tool":
    case "tool":
    case "work-runtime":
    case "runtime":
    case "hook-activity":
      return true;
    case "reasoning":
      return "status" in part || Boolean(part.source);
    default:
      return Boolean(part.source);
  }
}

/** A Work record in the UI-message vocabulary the block builder reads. */
function workRecordPart(part: Part, streaming: boolean): Part {
  const reasoning = part.type === "reasoning";
  const status =
    !streaming && part.status === "running"
      ? reasoning
        ? "completed"
        : "cancelled"
      : part.status;
  if (part.source)
    return {
      type: "data-subagent-activity",
      data: { ...part, status, type: reasoning ? "reasoning" : "tool" },
    };
  if (part.type === "hook-activity")
    return { type: "data-hook-activity", data: part.data };
  if (reasoning)
    return { ...part, state: status === "running" ? "streaming" : "done" };
  if (part.type === "work-tool" || part.type === "tool")
    return {
      ...part,
      type: "dynamic-tool",
      toolName: workToolName(part),
      state:
        part.isError || status === "failed"
          ? "output-error"
          : status === "cancelled"
            ? "input-available"
            : status === "running"
              ? "input-streaming"
              : "output-available",
      // Explicit cancellation also applies while the rest of the turn streams.
      workCancelled: status === "cancelled",
    };
  if (status === "failed" || status === "cancelled")
    return { type: "data-work-runtime", data: { ...part, status } };
  return OMITTED;
}

/**
 * Display parts in source order, one per stored slot so streamed IDs stay
 * stable. Composer references are the user's context, rendered by the shell.
 */
function contentParts(parts: readonly Part[], streaming: boolean): Part[] {
  return agentTimelineDisplayParts(parts).map((part) => {
    if (part.type === "text")
      return "reference" in part && part.reference ? OMITTED : part;
    return isWorkRecord(part) ? workRecordPart(part, streaming) : part;
  });
}

/**
 * Display-only: never mutates the stored parts. Text and attachments delimit
 * adjacent process steps; unrecognized metadata is ignored. IDs follow
 * immutable part slots, not growing content. Only the trailing live
 * text/thinking slot streams; stopped in-flight tools become cancelled.
 */
export function projectContent(
  messageId: string,
  stored: readonly Part[],
  { streaming }: { streaming: boolean },
): ContentBlock[] {
  const parts = contentParts(stored, streaming);
  const blocks: ContentBlock[] = [];
  const ruleTriggerIds = new Set<string>();
  const maintenance: ContentBlock[] = [];
  const appendStep = (step: ContentStep, partIndex: number) => {
    const previous = blocks.at(-1);
    if (previous?.kind === "process") previous.steps.push(step);
    else
      blocks.push({
        kind: "process",
        id: `${messageId}:process:${partIndex}`,
        status: "complete",
        steps: [step],
      });
  };

  parts.forEach((part, partIndex) => {
    const id = `${messageId}:part:${partIndex}`;
    if (part.type === STREAM_RULE_TRIGGER_PART) {
      const parsed = StreamRuleTriggerSchema.safeParse(part.data);
      if (parsed.success && !ruleTriggerIds.has(parsed.data.id)) {
        ruleTriggerIds.add(parsed.data.id);
        blocks.push({
          kind: "stream-rule",
          id: `${messageId}:rule:${parsed.data.id}`,
          trigger: parsed.data,
        });
      }
      return;
    }
    if (part.type === CONTEXT_MAINTENANCE_PART) {
      const parsed = ContextMaintenanceSchema.safeParse(part.data);
      if (parsed.success)
        maintenance.push({
          kind: "context-maintenance",
          id: `${messageId}:context:${parsed.data.kind}:${parsed.data.at}`,
          data: parsed.data,
        });
      return;
    }
    if (part.type === "text") {
      // Empty text slots still delimit process groups and retain their identity.
      blocks.push({
        kind: "text",
        id,
        text: typeof part.text === "string" ? part.text : "",
        streaming: streaming && part.state !== "done",
      });
      return;
    }
    if (part.type === "reasoning") {
      const live = streaming && part.state !== "done";
      const durationMs =
        !live &&
        typeof part.startedAt === "number" &&
        typeof part.completedAt === "number" &&
        part.completedAt >= part.startedAt
          ? part.completedAt - part.startedAt
          : undefined;
      appendStep(
        {
          kind: "thinking",
          id,
          text: typeof part.text === "string" ? part.text : "",
          streaming: live,
          ...(durationMs === undefined ? {} : { durationMs }),
        },
        partIndex,
      );
      return;
    }
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const toolCallId =
        typeof part.toolCallId === "string" ? part.toolCallId : id;
      appendStep(
        {
          kind: "tool",
          id: `${id}:tool:${toolCallId}`,
          toolCallId,
          toolName:
            typeof part.toolName === "string"
              ? part.toolName
              : part.type === "dynamic-tool"
                ? "tool"
                : part.type.slice(5),
          status:
            part.workCancelled === true
              ? "cancelled"
              : toolStatus(part.state, streaming),
          input: part.input,
          output: part.output,
          patch: typeof part.patch === "string" ? part.patch : undefined,
          truncated:
            typeof part.truncated === "boolean" ? part.truncated : undefined,
          firstChangedLine:
            typeof part.firstChangedLine === "number" &&
            Number.isInteger(part.firstChangedLine) &&
            part.firstChangedLine > 0
              ? part.firstChangedLine
              : undefined,
          durationMs:
            typeof part.durationMs === "number" ? part.durationMs : undefined,
          errorText:
            typeof part.errorText === "string" ? part.errorText : undefined,
        },
        partIndex,
      );
      return;
    }
    if (isProcessDataType(part.type)) {
      appendStep(
        { kind: "data", id, partIndex, type: part.type, data: part.data },
        partIndex,
      );
      return;
    }
    if (part.type === "file" || part.type === "image") {
      const url = part.type === "image" ? part.image : part.url;
      if (typeof url !== "string") return;
      blocks.push({
        kind: "file",
        id,
        partIndex,
        url,
        filename: typeof part.filename === "string" ? part.filename : undefined,
        mediaType:
          typeof part.mediaType === "string"
            ? part.mediaType
            : typeof part.mimeType === "string"
              ? part.mimeType
              : part.type === "image"
                ? "image/*"
                : "application/octet-stream",
      });
    }
  });
  // Runtime metadata precedes persisted text but follows streamed text. Keep
  // committed context operations at the turn boundary in both projections.
  blocks.push(...maintenance);

  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1;
    if (block.kind === "text") block.streaming &&= last;
    if (block.kind !== "process") return;
    block.steps.forEach((step, stepIndex) => {
      if (step.kind === "thinking")
        step.streaming &&= last && stepIndex === block.steps.length - 1;
    });
    block.status = contentProcessStatus(block.steps, streaming, last);
  });
  return blocks;
}

type LiveActivity = {
  type: "runtime" | "reasoning" | "tool";
  textOffset?: number;
  [key: string]: unknown;
};

/**
 * A live Work turn in the persisted record vocabulary, so it projects exactly
 * like the reply it becomes once stored.
 */
export function liveTurnParts(output: {
  text: string;
  activities: readonly LiveActivity[];
  budgetWarning?: unknown;
  streamRuleTriggers?: readonly StreamRuleTrigger[];
  startedAt?: number;
  runtimeKind?: string;
  modelName?: string;
}): Part[] {
  return [
    ...interleaveLiveText(output.activities, output.text).map((part): Part => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return part;
        case "tool":
          return { ...part, type: "work-tool" };
        case "runtime":
          return { ...part, type: "work-runtime" };
        default:
          return assertNever(part);
      }
    }),
    ...(output.budgetWarning
      ? [{ type: "data-budget-warning", data: output.budgetWarning }]
      : []),
    ...(output.streamRuleTriggers ?? []).map((data) => ({
      type: STREAM_RULE_TRIGGER_PART,
      data,
    })),
    ...(output.startedAt
      ? [
          {
            type: "data-work-timing",
            data: {
              startedAt: output.startedAt,
              ...(output.runtimeKind
                ? { runtimeKind: output.runtimeKind }
                : {}),
              ...(output.modelName ? { modelName: output.modelName } : {}),
            },
          },
        ]
      : []),
  ];
}
