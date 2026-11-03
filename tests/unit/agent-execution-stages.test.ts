import { describe, expect, it } from "vitest";
import {
  observeAgentExecutionStage,
  type AgentExecutionStage,
} from "@/lib/agents/execution-stages";

describe("native execution stages", () => {
  it("does not mistake turn or empty provider stream starts for model generation", async () => {
    const stages: AgentExecutionStage[] = [];
    const observe = observeAgentExecutionStage((stage) => {
      stages.push(stage);
    });
    await observe({ type: "turn_start" });
    await observe({ type: "message_start" });
    await observe({
      type: "message_update",
      assistantMessageEvent: { type: "start" },
    });
    expect(stages).toEqual([]);
    await observe({ type: "model_request" });
    await observe({ type: "message_start" });
    expect(stages).toEqual(["waiting-model"]);
    await observe({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta" },
    });
    await observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" },
    });
    expect(stages).toEqual(["waiting-model", "generating"]);
  });

  it("keeps parallel tools running and waits again only on the next actual request", async () => {
    const stages: AgentExecutionStage[] = [];
    const observe = observeAgentExecutionStage((stage) => {
      stages.push(stage);
    });
    await observe({ type: "model_request" });
    await observe({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta" },
    });
    await observe({ type: "tool_execution_start", toolCallId: "a" });
    await observe({ type: "tool_execution_start", toolCallId: "b" });
    await observe({ type: "tool_execution_end", toolCallId: "a" });
    expect(stages.at(-1)).toBe("tool-running");
    await observe({ type: "tool_execution_end", toolCallId: "b" });
    expect(stages.at(-1)).toBe("preparing");
    await observe({ type: "turn_start" });
    expect(stages.at(-1)).toBe("preparing");
    await observe({ type: "model_request" });
    await observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" },
    });
    expect(stages).toEqual([
      "waiting-model",
      "generating",
      "tool-running",
      "preparing",
      "waiting-model",
      "generating",
    ]);
  });
});
