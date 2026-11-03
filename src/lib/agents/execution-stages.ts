export type AgentExecutionStage =
  | "queued"
  | "preparing"
  | "waiting-model"
  | "generating"
  | "tool-running";

/** Native provider start precedes the request; only content events prove generation. */
export function observeAgentExecutionStage(
  publish: (stage: AgentExecutionStage) => void | Promise<void>,
) {
  let stage: AgentExecutionStage | undefined;
  const tools = new Set<string>();
  return async (event: {
    type: string;
    toolCallId?: string;
    assistantMessageEvent?: { type?: string };
  }) => {
    let next: AgentExecutionStage | undefined;
    if (event.type === "model_request") next = "waiting-model";
    else if (
      event.type === "message_update" &&
      [
        "text_start",
        "text_delta",
        "thinking_start",
        "thinking_delta",
        "toolcall_start",
        "toolcall_delta",
      ].includes(event.assistantMessageEvent?.type ?? "")
    )
      next = tools.size ? "tool-running" : "generating";
    else if (event.type === "tool_execution_start" && event.toolCallId) {
      tools.add(event.toolCallId);
      next = "tool-running";
    } else if (event.type === "tool_execution_end" && event.toolCallId) {
      tools.delete(event.toolCallId);
      next = tools.size ? "tool-running" : "preparing";
    }
    if (next && next !== stage) {
      stage = next;
      await publish(next);
    }
  };
}
