import type { UIMessage } from "ai";
import type { ContextUsageSnapshot } from "@/lib/context-usage";

export type AssistantSegment = {
  id: string;
  text: string;
};

export type TurnMessages = {
  segments: AssistantSegment[];
};

export type AgentUIData = {
  "assistant-messages": TurnMessages;
  "context-usage": ContextUsageSnapshot;
  model: { providerId: string; model: string };
  "agent-turn-model": { providerId: string; model: string };
  "subagent-activity": {
    type: "reasoning" | "tool";
    status: "running" | "completed" | "failed";
    source: {
      subagentId: string;
      subagentVersionId?: string;
      subagentName?: string;
      parentToolCallId?: string;
      depth?: number;
    };
    text?: string;
    delta?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
  };
  "hook-activity": {
    id: string;
    pluginInstallId: string;
    pluginName: string;
    event: string;
    status: "completed" | "failed" | "timed_out";
    durationMs: number;
    source?: AgentUIData["subagent-activity"]["source"];
    result?: "blocked" | "cancelled" | "modified" | "unchanged";
  };
};

export type AgentUIMessage = UIMessage<unknown, AgentUIData>;

type MessagePartLike = {
  type: string;
  data?: unknown;
};

export function assistantSegments(
  parts: readonly MessagePartLike[],
): AssistantSegment[] {
  const transcript = parts.find(
    (part) => part.type === "data-assistant-messages",
  );
  if (!transcript?.data || typeof transcript.data !== "object") return [];
  const segments = (transcript.data as { segments?: unknown }).segments;
  if (!Array.isArray(segments)) return [];
  return segments.flatMap((segment) => {
    if (!segment || typeof segment !== "object") return [];
    const { id, text } = segment as { id?: unknown; text?: unknown };
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      typeof text !== "string" ||
      !text.trim()
    ) {
      return [];
    }
    return [{ id: String(id), text }];
  });
}

export function expandAssistantMessages(
  messages: readonly AgentUIMessage[],
): AgentUIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    const segments = assistantSegments(message.parts);
    if (!segments.length) return [message];
    return segments.map((segment, index) => ({
      id: `${message.id}:segment:${segment.id}`,
      role: "assistant" as const,
      parts: [
        ...(index === 0
          ? message.parts.filter(
              (part) =>
                part.type === "data-subagent-activity" ||
                part.type === "data-hook-activity",
            )
          : []),
        { type: "text" as const, text: segment.text, state: "done" as const },
      ],
    }));
  });
}
