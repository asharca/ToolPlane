// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createNativeUiStreamBridge,
  createSandboxUiStreamBridge,
} from "@/lib/agents/ui-stream";

const message: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const tool = {
  type: "toolCall" as const,
  id: "call",
  name: "tool",
  arguments: {},
};

describe("stream bridge lifecycle and failures", () => {
  it("reuses started content ids and ignores repeated or unknown ends", () => {
    const write = vi.fn();
    const bridge = createNativeUiStreamBridge({ write }, "n");
    bridge.onEvent({ type: "text_start", contentIndex: 0, partial: message });
    bridge.onEvent({
      type: "text_delta",
      contentIndex: 0,
      delta: "one",
      partial: message,
    });
    bridge.onEvent({
      type: "text_end",
      contentIndex: 0,
      content: "one",
      partial: message,
    });
    bridge.onEvent({
      type: "text_end",
      contentIndex: 0,
      content: "one",
      partial: message,
    });
    bridge.onEvent({
      type: "thinking_start",
      contentIndex: 1,
      partial: message,
    });
    bridge.onEvent({
      type: "thinking_delta",
      contentIndex: 1,
      delta: "plan",
      partial: message,
    });
    bridge.onEvent({
      type: "thinking_end",
      contentIndex: 1,
      content: "plan",
      partial: message,
    });
    bridge.onEvent({
      type: "thinking_end",
      contentIndex: 8,
      content: "",
      partial: message,
    });
    bridge.onEvent({ type: "done", reason: "stop", message });
    bridge.finish();
    bridge.finish();
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
      { type: "text-start", id: "n-text-0" },
      { type: "text-delta", id: "n-text-0", delta: "one" },
      { type: "text-end", id: "n-text-0" },
      { type: "reasoning-start", id: "n-reasoning-1" },
      { type: "reasoning-delta", id: "n-reasoning-1", delta: "plan" },
      { type: "reasoning-end", id: "n-reasoning-1" },
    ]);
  });
  it.each([new Error("denied"), "denied", { error: "denied" }, BigInt(1)])(
    "serializes native errors %#",
    (error) => {
      const write = vi.fn();
      const bridge = createNativeUiStreamBridge({ write }, "n");
      bridge.onToolResult(tool, error, true);
      expect(write).toHaveBeenCalledWith({
        type: "tool-output-error",
        toolCallId: "call",
        errorText:
          error instanceof Error
            ? "denied"
            : typeof error === "object"
              ? '{"error":"denied"}'
              : String(error),
      });
    },
  );
  it("deduplicates sandbox tools and supplies absent names, inputs and results", () => {
    const write = vi.fn();
    const bridge = createSandboxUiStreamBridge({ write }, "s");
    bridge.onActivity({ type: "tool", status: "running" });
    bridge.onActivity({ type: "tool", status: "running", toolCallId: "a" });
    bridge.onActivity({ type: "tool", status: "running", toolCallId: "a" });
    bridge.onActivity({ type: "tool", status: "completed", toolCallId: "a" });
    bridge.onActivity({
      type: "tool",
      status: "completed",
      toolCallId: "a",
      output: "duplicate",
    });
    bridge.onActivity({ type: "tool", status: "failed", toolCallId: "b" });
    bridge.onActivity({
      type: "tool",
      status: "completed",
      toolCallId: "c",
      isError: true,
      output: { reason: "denied" },
    });
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
      { type: "tool-input-start", toolCallId: "a", toolName: "tool" },
      {
        type: "tool-input-available",
        toolCallId: "a",
        toolName: "tool",
        input: {},
      },
      { type: "tool-output-available", toolCallId: "a", output: null },
      { type: "tool-input-start", toolCallId: "b", toolName: "tool" },
      {
        type: "tool-input-available",
        toolCallId: "b",
        toolName: "tool",
        input: {},
      },
      { type: "tool-output-error", toolCallId: "b", errorText: "Tool failed" },
      { type: "tool-input-start", toolCallId: "c", toolName: "tool" },
      {
        type: "tool-input-available",
        toolCallId: "c",
        toolName: "tool",
        input: {},
      },
      {
        type: "tool-output-error",
        toolCallId: "c",
        errorText: '{"reason":"denied"}',
      },
    ]);
  });
  it("groups reasoning deltas, closes on status transitions and text, and finishes once", () => {
    const write = vi.fn();
    const bridge = createSandboxUiStreamBridge({ write }, "s");
    bridge.onTextDelta("one");
    bridge.onTextDelta("two");
    bridge.onActivity({ type: "reasoning", status: "running" });
    bridge.onActivity({ type: "reasoning", status: "running", delta: "plan" });
    bridge.onActivity({ type: "reasoning", status: "completed" });
    bridge.onActivity({ type: "reasoning", status: "running", delta: "more" });
    bridge.onTextDelta("answer");
    bridge.finish();
    bridge.finish();
    expect(write.mock.calls.map(([chunk]) => chunk.type)).toEqual([
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ]);
  });
});
