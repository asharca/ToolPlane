import { describe, expect, it, vi } from "vitest";
import {
  parseClaudeStreamLine,
  parseDshEventLine,
  parsePiStreamLine,
} from "@/lib/agents/sandbox-runtime";

vi.mock("@/lib/db", () => ({ db: {} }));

const pi = (event: unknown) => parsePiStreamLine(JSON.stringify(event));
const claude = (event: unknown) => parseClaudeStreamLine(JSON.stringify(event));
const dsh = (event: unknown) =>
  parseDshEventLine(`event:${JSON.stringify(event)}`, "event:");

describe("sandbox runtime stream protocol boundaries", () => {
  it("takes the latest meaningful assistant result rather than trailing tool messages", () => {
    expect(
      pi({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "old" }] },
          {
            role: "assistant",
            content: [null, {}, { type: "text", text: "final" }],
            usage: { input: 12, output: 3 },
          },
          { role: "tool", content: "private tool response" },
          { role: "assistant", content: [] },
        ],
      }),
    ).toEqual({ assistantText: "final", contextTokens: 15 });
    expect(
      pi({ type: "agent_end", messages: [null, { role: "user" }] }),
    ).toBeNull();
  });

  it.each(["error", "aborted"])(
    "preserves Pi %s failures even without assistant text",
    (stopReason) => {
      expect(
        pi({ type: "message_end", message: { role: "assistant", stopReason } }),
      ).toEqual({ error: `Pi request ${stopReason}.`, isError: true });
      expect(
        pi({
          type: "turn_end",
          message: {
            role: "assistant",
            stopReason,
            errorMessage: "provider refused",
            usage: { totalTokens: 0 },
          },
        }),
      ).toEqual({ error: "provider refused", isError: true, contextTokens: 0 });
    },
  );

  it.each([
    null,
    [],
    { input: 2 },
    { input: -1, output: 3 },
    { totalTokens: "4" },
  ])("does not invent context usage from malformed usage %j", (usage) => {
    expect(
      pi({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage,
        },
      }),
    ).toEqual({ assistantText: "ok" });
  });

  it("projects Pi reasoning boundaries and tool failure without requiring a tool name", () => {
    expect(
      pi({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start" },
      }),
    ).toEqual({ activities: [{ type: "reasoning", status: "running" }] });
    expect(
      pi({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end" },
      }),
    ).toEqual({ activities: [{ type: "reasoning", status: "completed" }] });
    expect(
      pi({
        type: "tool_execution_end",
        toolCallId: "call",
        result: "denied",
        isError: true,
      }),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "failed",
          toolCallId: "call",
          output: "denied",
          isError: true,
        },
      ],
    });
  });

  it("projects Claude tool and thinking deltas before a completed assistant message", () => {
    expect(
      claude({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { path: "a" },
          },
        },
      }),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: "read-1",
          toolName: "Read",
          input: { path: "a" },
        },
      ],
    });
    expect(
      claude({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "checking" },
        },
      }),
    ).toEqual({
      activities: [{ type: "reasoning", status: "running", delta: "checking" }],
    });
  });

  it("filters invalid Claude content while preserving valid text, tools and cache usage", () => {
    expect(
      claude({
        type: "assistant",
        message: {
          content: [
            null,
            4,
            {},
            { type: "text", text: "answer" },
            { type: "tool_use", id: "call", name: "Read", input: {} },
            { type: "tool_use", id: 3 },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        },
      }),
    ).toEqual({
      assistantText: "answer",
      contextTokens: 10,
      activities: [
        {
          type: "tool",
          status: "running",
          toolCallId: "call",
          toolName: "Read",
          input: {},
        },
      ],
    });
    expect(
      claude({
        type: "user",
        message: {
          content: [
            null,
            {},
            { type: "text", text: "not a result" },
            {
              type: "tool_result",
              tool_use_id: "call",
              content: "failure",
              is_error: true,
            },
          ],
        },
      }),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "failed",
          toolCallId: "call",
          output: "failure",
          isError: true,
        },
      ],
    });
    expect(claude({ type: "user", message: { content: [{}] } })).toBeNull();
  });

  it("reports compaction failure and filters mixed Claude error arrays", () => {
    expect(
      claude({ type: "system", subtype: "status", compact_result: "failed" }),
    ).toEqual({ result: "Compaction failed.", isError: true });
    expect(
      claude({ type: "system", subtype: "status", compact_error: "too large" }),
    ).toEqual({ result: "too large", isError: true });
    expect(
      claude({
        type: "result",
        errors: ["denied", null, 42, "retry later"],
        is_error: true,
        usage: [],
      }),
    ).toEqual({ result: "denied\nretry later", isError: true });
    expect(claude({ type: "result", usage: { input_tokens: -1 } })).toEqual({});
  });

  it.each([
    null,
    2,
    {},
    { type: "unknown" },
    { type: "assistant", message: { content: "invalid" } },
    { type: "user", message: { content: "invalid" } },
  ])("ignores unsupported Claude payload %j", (payload) => {
    expect(claude(payload)).toBeNull();
  });

  it("retains malformed dsh tool arguments for diagnostics and treats failed status as an error", () => {
    expect(
      dsh({
        type: "tool",
        status: "failed",
        toolCallId: "call",
        input: "{broken",
        output: { error: "bad arguments" },
      }),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "failed",
          toolCallId: "call",
          input: "{broken",
          output: { error: "bad arguments" },
          isError: true,
        },
      ],
    });
    expect(
      dsh({
        type: "tool",
        status: "completed",
        toolCallId: "call",
        input: '{"path":"a"}',
      }),
    ).toEqual({
      activities: [
        {
          type: "tool",
          status: "completed",
          toolCallId: "call",
          input: { path: "a" },
          isError: false,
        },
      ],
    });
    expect(dsh({ type: "reasoning", status: "completed" })).toEqual({
      activities: [{ type: "reasoning", status: "completed" }],
    });
  });

  it.each(["not json", "null", "1"])(
    "rejects malformed protocol lines %s",
    (line) => {
      expect(parsePiStreamLine(line)).toBeNull();
      expect(parseClaudeStreamLine(line)).toBeNull();
      expect(parseDshEventLine(`event:${line}`, "event:")).toBeNull();
    },
  );

  it("ignores unrelated dsh output and invalid event statuses", () => {
    expect(parseDshEventLine("event:{}", "")).toBeNull();
    expect(parseDshEventLine("log message", "event:")).toBeNull();
    expect(
      dsh({ type: "tool", toolCallId: "call", status: "pending" }),
    ).toBeNull();
    expect(dsh({ type: "reasoning", status: "failed" })).toBeNull();
  });
});
