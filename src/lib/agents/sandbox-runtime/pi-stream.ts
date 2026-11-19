import "server-only";
import { z } from "zod";
import type { SandboxRuntimeActivity } from "../sandbox-runtime";

export type PiStreamLine = {
  delta?: string;
  assistantText?: string;
  contextTokens?: number;
  error?: string;
  isError?: boolean;
  activities?: SandboxRuntimeActivity[];
};

function usageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function piContextTokens(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const total = usageNumber(usage.totalTokens);
  if (total !== null) return total;
  const input = usageNumber(usage.input);
  const output = usageNumber(usage.output);
  return input !== null && output !== null ? input + output : null;
}

function piMessageResult(message: unknown): PiStreamLine | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.role !== "assistant") return null;
  const content = Array.isArray(value.content) ? value.content : [];
  const assistantText = content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? [(part as Record<string, unknown>).text as string]
        : [],
    )
    .join("");
  const isError =
    value.stopReason === "error" || value.stopReason === "aborted";
  const error =
    typeof value.errorMessage === "string"
      ? value.errorMessage
      : isError
        ? `Pi request ${String(value.stopReason)}.`
        : "";
  const contextTokens = piContextTokens(value.usage);
  if (!assistantText && !error && contextTokens === null) return null;
  return {
    ...(assistantText ? { assistantText } : {}),
    ...(contextTokens !== null ? { contextTokens } : {}),
    ...(error ? { error } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

const PiEventSourceSchema = z.object({
  subagentId: z.string().min(1).max(240),
  subagentVersionId: z.string().min(1).max(240).optional(),
  subagentName: z.string().max(240).optional(),
  parentToolCallId: z.string().min(1).max(240).optional(),
  depth: z.number().int().min(0).max(32).optional(),
});

export function parsePiEvent(value: unknown): PiStreamLine | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (payload.source !== undefined) {
    const source = PiEventSourceSchema.safeParse(payload.source);
    if (!source.success) return null;
    const parentEvent = { ...payload };
    delete parentEvent.source;
    const parsed = parsePiEvent(parentEvent);
    if (!parsed) return null;
    // A child's answer is activity, never an incremental part of the parent answer.
    const activities =
      parsed.activities ??
      (parsed.delta
        ? [
            {
              type: "reasoning" as const,
              status: "running" as const,
              delta: parsed.delta,
            },
          ]
        : []);
    return {
      activities: activities.map((activity) => ({
        ...activity,
        source: source.data,
      })),
    };
  }
  if (
    payload.type === "toolplane_mcp_origin" &&
    typeof payload.toolCallId === "string" &&
    typeof payload.deploymentId === "string" &&
    typeof payload.originalToolName === "string"
  ) {
    return {
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: payload.toolCallId,
          deploymentId: payload.deploymentId,
          originalToolName: payload.originalToolName,
        },
      ],
    };
  }
  if (
    payload.type === "message_update" &&
    payload.assistantMessageEvent &&
    typeof payload.assistantMessageEvent === "object"
  ) {
    const event = payload.assistantMessageEvent as Record<string, unknown>;
    if (event.type === "text_delta" && typeof event.delta === "string")
      return { delta: event.delta };
    if (event.type === "thinking_start") {
      return { activities: [{ type: "reasoning", status: "running" }] };
    }
    if (event.type === "thinking_delta" && typeof event.delta === "string") {
      return {
        activities: [
          { type: "reasoning", status: "running", delta: event.delta },
        ],
      };
    }
    if (event.type === "thinking_end") {
      return { activities: [{ type: "reasoning", status: "completed" }] };
    }
  }
  if (
    payload.type === "tool_execution_start" &&
    typeof payload.toolCallId === "string" &&
    typeof payload.toolName === "string"
  ) {
    return {
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          input: payload.args,
        },
      ],
    };
  }
  if (
    payload.type === "tool_execution_end" &&
    typeof payload.toolCallId === "string"
  ) {
    return {
      activities: [
        {
          type: "tool",
          status: payload.isError === true ? "failed" : "completed",
          toolCallId: payload.toolCallId,
          ...(typeof payload.toolName === "string"
            ? { toolName: payload.toolName }
            : {}),
          output: payload.result,
          ...(typeof payload.patch === "string"
            ? {
                patch: payload.patch,
                truncated: payload.truncated === true,
                ...(Number.isInteger(payload.firstChangedLine) &&
                Number(payload.firstChangedLine) > 0
                  ? { firstChangedLine: Number(payload.firstChangedLine) }
                  : {}),
              }
            : {}),
          isError: payload.isError === true,
        },
      ],
    };
  }
  if (payload.type === "message_end" || payload.type === "turn_end") {
    return piMessageResult(payload.message);
  }
  if (payload.type === "agent_end" && Array.isArray(payload.messages)) {
    for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
      const result = piMessageResult(payload.messages[index]);
      if (result) return result;
    }
  }
  return null;
}
export function parsePiStreamLine(line: string): PiStreamLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return parsePiEvent(value);
}
