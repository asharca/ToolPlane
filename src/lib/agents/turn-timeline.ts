import type { AgentExecutionStage } from "@/lib/agents/execution-stages";
import { interleaveLiveText } from "@/lib/conversation/content-blocks";

/** Timing and process of one Agent turn, persisted on chat, channel, trigger and command replies. */
export const AGENT_TURN_TIMELINE_PART = "data-agent-timeline";

/** Live output payloads are already sanitized to JSON-safe values. */
type TimelineJson =
  | string
  | number
  | boolean
  | null
  | TimelineJson[]
  | { [key: string]: TimelineJson };

export type AgentTurnTimelineStep = {
  type: "tool" | "reasoning";
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  toolCallId?: string;
  toolName?: string;
  deploymentName?: string;
  originalToolName?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  isError?: boolean;
  text?: string;
  input?: TimelineJson;
  output?: TimelineJson;
  patch?: string;
  truncated?: boolean;
  firstChangedLine?: number;
  /** Position in the persisted reply text where this step began. */
  textOffset?: number;
  source?: { subagentId: string; parentToolCallId?: string };
};

export type AgentTurnTimeline = {
  startedAt: number;
  completedAt: number;
  stages?: Array<{ stage: AgentExecutionStage; at: number }>;
  modelName?: string;
  steps: AgentTurnTimelineStep[];
};

type OutputLike = {
  text: string;
  startedAt?: number;
  completedAt?: number;
  stages?: Array<{ stage: AgentExecutionStage; at: number }>;
  modelName?: string;
  activities: ReadonlyArray<
    Omit<AgentTurnTimelineStep, "type" | "source" | "input" | "output"> & {
      type: "runtime" | "reasoning" | "tool";
      source?: { subagentId: string; parentToolCallId?: string };
      input?: unknown;
      output?: unknown;
    }
  >;
};

const whitespace = (character: string | undefined) =>
  character !== undefined && /\s/.test(character);

/**
 * Map offsets in the streamed text onto the persisted reply, which joins the
 * same segments with blank lines. Any other difference drops the offsets.
 */
function replyOffsets(
  streamed: string,
  reply: string,
  offsets: readonly number[],
): Map<number, number> | null {
  const mapped = new Map<number, number>();
  let from = 0;
  let to = 0;
  for (const offset of [...new Set(offsets)].sort((a, b) => a - b)) {
    const target = Math.min(Math.max(offset, 0), streamed.length);
    while (from < target) {
      if (streamed[from] === reply[to]) {
        from++;
        to++;
      } else if (whitespace(streamed[from])) from++;
      else if (whitespace(reply[to])) to++;
      else return null;
    }
    mapped.set(offset, to);
  }
  return mapped;
}

/**
 * Keep the settled process record: timing, names, reasoning and the bounded,
 * redacted tool payloads the live output already exposed to observers.
 * `replyText` re-anchors steps on the persisted reply text.
 */
export function agentTurnTimeline(
  output: OutputLike,
  replyText?: string,
): AgentTurnTimeline | null {
  if (
    typeof output.startedAt !== "number" ||
    typeof output.completedAt !== "number" ||
    output.completedAt < output.startedAt
  )
    return null;
  const offsets =
    replyText === undefined
      ? null
      : replyOffsets(
          output.text,
          replyText,
          output.activities.flatMap((activity) =>
            activity.textOffset === undefined ? [] : [activity.textOffset],
          ),
        );
  return {
    startedAt: output.startedAt,
    completedAt: output.completedAt,
    ...(output.stages?.length ? { stages: output.stages } : {}),
    ...(output.modelName ? { modelName: output.modelName } : {}),
    steps: output.activities.flatMap((activity): AgentTurnTimelineStep[] => {
      if (activity.type === "runtime") return [];
      const textOffset =
        activity.textOffset === undefined
          ? undefined
          : replyText === undefined
            ? activity.textOffset
            : offsets?.get(activity.textOffset);
      return [
        {
          type: activity.type,
          id: activity.id,
          status: activity.status,
          ...(activity.toolCallId ? { toolCallId: activity.toolCallId } : {}),
          ...(activity.toolName ? { toolName: activity.toolName } : {}),
          ...(activity.deploymentName
            ? { deploymentName: activity.deploymentName }
            : {}),
          ...(activity.originalToolName
            ? { originalToolName: activity.originalToolName }
            : {}),
          ...(activity.startedAt === undefined
            ? {}
            : { startedAt: activity.startedAt }),
          ...(activity.completedAt === undefined
            ? {}
            : { completedAt: activity.completedAt }),
          ...(activity.durationMs === undefined
            ? {}
            : { durationMs: activity.durationMs }),
          ...(activity.isError ? { isError: true } : {}),
          ...(activity.type === "reasoning" && activity.text
            ? { text: activity.text }
            : {}),
          ...(activity.input === undefined
            ? {}
            : { input: activity.input as TimelineJson }),
          ...(activity.output === undefined
            ? {}
            : { output: activity.output as TimelineJson }),
          ...(activity.patch === undefined
            ? {}
            : {
                patch: activity.patch,
                truncated: activity.truncated === true,
                ...(activity.firstChangedLine === undefined
                  ? {}
                  : { firstChangedLine: activity.firstChangedLine }),
              }),
          ...(textOffset === undefined ? {} : { textOffset }),
          ...(activity.source
            ? {
                source: {
                  subagentId: activity.source.subagentId,
                  ...(activity.source.parentToolCallId
                    ? { parentToolCallId: activity.source.parentToolCallId }
                    : {}),
                },
              }
            : {}),
        },
      ];
    }),
  };
}

export function parseAgentTurnTimeline(
  value: unknown,
): AgentTurnTimeline | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<AgentTurnTimeline>;
  return typeof data.startedAt === "number" &&
    typeof data.completedAt === "number" &&
    Array.isArray(data.steps)
    ? (data as AgentTurnTimeline)
    : null;
}

type DisplayPart = { type: string; [key: string]: unknown };

/**
 * A persisted reply's display parts with its recorded process: steps are placed
 * where the reply text stood when they began; other parts keep their slots.
 * Parts without a timeline are returned unchanged.
 */
export function agentTimelineDisplayParts<Part extends DisplayPart>(
  parts: readonly Part[],
): Array<Part | AgentTurnTimelineStep | { type: "text"; text: string }> {
  const timeline = parseAgentTurnTimeline(
    parts.find((part) => part.type === AGENT_TURN_TIMELINE_PART)?.data,
  );
  if (!timeline) return [...parts];
  // Chat replies also persist their subagent activity as its own parts.
  const childrenPersisted = parts.some(
    (part) => part.type === "data-subagent-activity",
  );
  const steps = timeline.steps.filter(
    (step) => !childrenPersisted || !step.source,
  );
  const isReplyText = (part: DisplayPart) =>
    part.type === "text" && typeof part.text === "string" && !part.reference;
  const text = parts
    .filter(isReplyText)
    .map((part) => part.text as string)
    .join("\n\n");
  const process = interleaveLiveText(steps, text);
  const display: Array<Part | (typeof process)[number]> = [];
  let placed = false;
  for (const part of parts) {
    if (!isReplyText(part)) display.push(part);
    else if (!placed) {
      display.push(...process);
      placed = true;
    }
  }
  if (!placed) display.push(...process);
  return display;
}
