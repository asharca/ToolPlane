import type { AgentExecutionStage } from "@/lib/agents/execution-stages";

/** Timing of one Agent turn, persisted on chat, channel, trigger and command replies. */
export const AGENT_TURN_TIMELINE_PART = "data-agent-timeline";

const STEP_TEXT_CHARACTERS = 500;

export type AgentTurnTimelineStep = {
  type: "tool" | "reasoning";
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  toolCallId?: string;
  toolName?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  isError?: boolean;
  text?: string;
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
  startedAt?: number;
  completedAt?: number;
  stages?: Array<{ stage: AgentExecutionStage; at: number }>;
  modelName?: string;
  activities: ReadonlyArray<{
    id: string;
    type: "runtime" | "reasoning" | "tool";
    status: AgentTurnTimelineStep["status"];
    toolCallId?: string;
    toolName?: string;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    isError?: boolean;
    text?: string;
    source?: { subagentId: string; parentToolCallId?: string };
  }>;
};

/** Keep timing and names only; tool payloads stay in the task ledger. */
export function agentTurnTimeline(
  output: OutputLike,
): AgentTurnTimeline | null {
  if (
    typeof output.startedAt !== "number" ||
    typeof output.completedAt !== "number" ||
    output.completedAt < output.startedAt
  )
    return null;
  return {
    startedAt: output.startedAt,
    completedAt: output.completedAt,
    ...(output.stages?.length ? { stages: output.stages } : {}),
    ...(output.modelName ? { modelName: output.modelName } : {}),
    steps: output.activities.flatMap((activity): AgentTurnTimelineStep[] =>
      activity.type === "runtime"
        ? []
        : [
            {
              type: activity.type,
              id: activity.id,
              status: activity.status,
              ...(activity.toolCallId
                ? { toolCallId: activity.toolCallId }
                : {}),
              ...(activity.toolName ? { toolName: activity.toolName } : {}),
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
                ? { text: activity.text.slice(0, STEP_TEXT_CHARACTERS) }
                : {}),
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
          ],
    ),
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
