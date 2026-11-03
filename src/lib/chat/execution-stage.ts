export const CHAT_EXECUTION_LABELS = {
  queued: "executionQueued",
  preparing: "executionPreparing",
  "waiting-model": "executionWaitingModel",
  generating: "executionGenerating",
  "tool-running": "executionToolRunning",
} as const;

export type ChatExecutionStage = keyof typeof CHAT_EXECUTION_LABELS;
export type ChatExecutionProgress = {
  runId: string;
  stage: ChatExecutionStage;
  sequence: number;
};

export function readChatExecutionProgress(
  value: unknown,
): ChatExecutionProgress | null {
  if (!value || typeof value !== "object") return null;
  const progress = value as ChatExecutionProgress;
  return typeof progress.runId === "string" &&
    typeof progress.stage === "string" &&
    Object.hasOwn(CHAT_EXECUTION_LABELS, progress.stage) &&
    Number.isSafeInteger(progress.sequence) &&
    progress.sequence > 0
    ? progress
    : null;
}

// Transient UI data is replayable from Run events, never part of saved messages.
export function chatExecutionProgressChunk(
  runId: string,
  stage: ChatExecutionStage,
  sequence: number,
) {
  return {
    type: "data-chat-execution" as const,
    transient: true,
    data: { runId, stage, sequence },
  };
}
