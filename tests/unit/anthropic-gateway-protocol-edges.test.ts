// @vitest-environment node
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ buildModel: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/agents/model", () => ({ buildModel: mocks.buildModel }));
import { handleAnthropicMessages } from "@/lib/agents/anthropic-gateway";

const provider = {
  id: "p",
  name: "P",
  format: "openai",
  baseUrl: "https://invalid.test",
  apiKey: "secret",
};
function message(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "p",
    model: "m",
    timestamp: 1,
    stopReason: "stop",
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function request(extra: Record<string, unknown> = {}) {
  return new Request("http://local/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "Hi" }],
      ...extra,
    }),
  });
}
function stream(events: AssistantMessageEvent[], result = message()) {
  return {
    result: async () => result,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}
function events(
  text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  return text
    .trim()
    .split("\n\n")
    .map((block) => {
      const [event, data] = block.split("\n");
      return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
    });
}

describe("Anthropic gateway protocol edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.buildModel.mockReturnValue({
      models: { streamSimple: mocks.stream },
      model: {
        id: "m",
        api: "openai-completions",
        provider: "p",
        reasoning: false,
      },
    });
    mocks.stream.mockReturnValue(stream([]));
  });

  it("normalizes mixed history without losing tool result ordering or image boundaries", async () => {
    await handleAnthropicMessages(
      request({
        system: [
          { type: "image" },
          { type: "text", text: "A" },
          { type: "text", text: 7 },
          { type: "text", text: "B" },
        ],
        tools: [{ name: "read", input_schema: {} }],
        messages: [
          { role: "assistant", content: "" },
          {
            role: "assistant",
            content: [{ type: "text", text: "" }, { type: "unknown" }],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "history" },
              { type: "thinking", thinking: "thought", signature: "sig" },
              { type: "thinking" },
              { type: "redacted_thinking", data: "redacted" },
              {
                type: "tool_use",
                id: "call|provider",
                name: "read",
                input: [],
              },
              { type: "tool_use" },
            ],
          },
          { role: "user", content: "" },
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              {
                type: "image",
                source: { type: "base64", data: "AA", media_type: "image/png" },
              },
              {
                type: "image",
                source: { type: "url", data: "no", media_type: "image/png" },
              },
              { type: "image", source: [] },
              {
                type: "tool_result",
                tool_use_id: "call",
                content: [{ type: "text", text: "answer" }],
              },
              {
                type: "tool_result",
                tool_use_id: "unknown",
                content: { ok: true },
                is_error: true,
              },
              { type: "tool_result", content: null },
              { type: "tool_result", content: "" },
              { type: "text", text: "after" },
            ],
          },
        ],
      }),
      provider,
    );
    const context = mocks.stream.mock.calls[0][1] as Context;
    expect(context.systemPrompt).toBe("A\n\nB");
    expect(context.tools?.[0]).toMatchObject({ name: "read", description: "" });
    expect(context.messages.map((row) => row.role)).toEqual([
      "assistant",
      "user",
      "toolResult",
      "toolResult",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(context.messages[0]).toMatchObject({
      stopReason: "toolUse",
      content: [
        { text: "history" },
        { thinkingSignature: "sig" },
        { thinking: "" },
        { redacted: true },
        { id: "call", arguments: {} },
        { name: "tool", arguments: {} },
      ],
    });
    expect(context.messages[1]).toMatchObject({
      content: [
        { text: "before" },
        { type: "image", data: "AA", mimeType: "image/png" },
      ],
    });
    expect(context.messages[2]).toMatchObject({
      toolName: "read",
      content: [{ text: "answer" }],
      isError: false,
    });
    expect(context.messages[3]).toMatchObject({
      toolName: "tool",
      content: [{ text: '{"ok":true}' }],
      isError: true,
    });
    expect(context.messages[4]).toMatchObject({
      toolCallId: expect.stringMatching(/^toolu_/),
      content: [],
    });
  });

  it.each([
    ["any", undefined, "required"],
    ["none", undefined, "none"],
    ["auto", undefined, "auto"],
    ["tool", "read", { type: "function", function: { name: "read" } }],
    ["tool", undefined, undefined],
    ["unknown", undefined, undefined],
  ])(
    "translates %s tool selection into an OpenAI payload",
    async (type, name, expected) => {
      await handleAnthropicMessages(
        request({
          tool_choice: { type, name, disable_parallel_tool_use: true },
          temperature: 0.7,
          top_p: 0.9,
          stop_sequences: ["END"],
        }),
        provider,
      );
      const options = mocks.stream.mock.calls[0][2];
      expect(options).toMatchObject({
        temperature: 0.7,
        samplingParams: { top_p: 0.9, stop: ["END"] },
      });
      expect(options.onPayload({ existing: true })).toEqual({
        existing: true,
        ...(expected === undefined ? {} : { tool_choice: expected }),
        parallel_tool_calls: false,
      });
      expect(options.onPayload(null)).toBeUndefined();
    },
  );

  it.each([
    [2048, "low"],
    [8192, "medium"],
    [8193, "high"],
    ["invalid", "medium"],
  ])("maps thinking budget %s", async (budget, expected) => {
    mocks.buildModel.mockReturnValue({
      models: { streamSimple: mocks.stream },
      model: { id: "m", reasoning: true },
    });
    await handleAnthropicMessages(
      request({
        thinking: { type: "enabled", budget_tokens: budget },
        temperature: 1,
        top_p: 1,
      }),
      provider,
    );
    const options = mocks.stream.mock.calls[0][2];
    expect(options.reasoning).toBe(expected);
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("samplingParams");
    expect(options.onPayload({})).toBeUndefined();
  });

  it("preserves response model, cached usage, redacted reasoning and sanitized tool IDs", async () => {
    const result = message([
      { type: "thinking", thinking: "x" },
      { type: "thinking", thinking: "", redacted: true },
      {
        type: "toolCall",
        id: "!".repeat(80),
        name: "unmapped",
        arguments: { a: 1 },
      },
    ]);
    result.stopReason = "length";
    result.responseModel = "actual-model";
    result.usage.cacheRead = 4;
    result.usage.cacheWrite = 5;
    mocks.stream.mockReturnValue(stream([], result));
    const response = await handleAnthropicMessages(
      request({ thinking: { type: "disabled" }, system: "" }),
      provider,
    );
    expect(await response.json()).toMatchObject({
      model: "actual-model",
      stop_reason: "max_tokens",
      usage: { cache_read_input_tokens: 4, cache_creation_input_tokens: 5 },
      content: [
        { type: "thinking", signature: "" },
        { type: "redacted_thinking", data: "" },
        { id: expect.stringMatching(/^toolu_[a-f0-9]{48}$/), name: "unmapped" },
      ],
    });
  });

  it.each(["error", "aborted"] as const)(
    "returns a provider %s before committing JSON",
    async (stopReason) => {
      mocks.stream.mockReturnValue(stream([], { ...message(), stopReason }));
      const response = await handleAnthropicMessages(request(), provider);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: { message: "Model request failed.", type: "api_error" },
      });
    },
  );

  it("reports a stream that never starts", async () => {
    const response = await handleAnthropicMessages(
      request({ stream: true }),
      provider,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { message: "Model stream ended before it started." },
    });
  });

  it("serializes text, signed and redacted thinking, and tools without partial JSON", async () => {
    const partial = message([
      { type: "thinking", thinking: "reason", thinkingSignature: "sig" },
      { type: "thinking", thinking: "", redacted: true },
      { type: "text", text: "answer" },
    ]);
    const call = {
      type: "toolCall" as const,
      id: "id",
      name: "tool",
      arguments: { complete: true },
    };
    const rows: AssistantMessageEvent[] = [
      { type: "start", partial },
      { type: "thinking_start", contentIndex: 0, partial },
      { type: "thinking_delta", contentIndex: 0, delta: "reason", partial },
      { type: "thinking_end", contentIndex: 0, content: "reason", partial },
      { type: "thinking_start", contentIndex: 1, partial },
      { type: "thinking_end", contentIndex: 1, content: "", partial },
      { type: "thinking_start", contentIndex: 8, partial },
      { type: "thinking_end", contentIndex: 8, content: "", partial },
      { type: "text_start", contentIndex: 2, partial },
      { type: "text_delta", contentIndex: 2, delta: "answer", partial },
      { type: "text_end", contentIndex: 2, content: "answer", partial },
      { type: "toolcall_start", contentIndex: 3, partial },
      { type: "toolcall_end", contentIndex: 3, toolCall: call, partial },
      { type: "toolcall_delta", contentIndex: 9, delta: "{}", partial },
      { type: "toolcall_end", contentIndex: 9, toolCall: call, partial },
      {
        type: "done",
        reason: "length",
        message: { ...partial, stopReason: "length" },
      },
    ];
    mocks.stream.mockReturnValue(stream(rows));
    const response = await handleAnthropicMessages(
      request({ stream: true }),
      provider,
    );
    const parsed = events(await response.text());
    expect(
      parsed.filter((row) => row.event === "content_block_stop"),
    ).toHaveLength(6);
    expect(parsed.map((row) => row.data)).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig" },
    });
    expect(parsed.map((row) => row.data)).toContainEqual({
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"complete":true}' },
    });
    expect(parsed.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "max_tokens" },
    });
    expect(parsed.at(-1)?.event).toBe("message_stop");
  });

  it.each(["eof", "error", "throw"])(
    "emits protocol error after committed stream: %s",
    async (failure) => {
      const partial = message();
      mocks.stream.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial };
          if (failure === "error")
            yield { type: "error", reason: "error", error: partial };
          if (failure === "throw") throw "socket closed";
        },
      });
      const response = await handleAnthropicMessages(
        request({ stream: true }),
        provider,
      );
      expect(response.status).toBe(200);
      expect(events(await response.text()).at(-1)).toMatchObject({
        event: "error",
        data: {
          error: {
            message:
              failure === "eof"
                ? "Model stream ended before completion."
                : failure === "throw"
                  ? "socket closed"
                  : "Model request failed.",
          },
        },
      });
    },
  );

  it("cancels the provider iterator and aborts its signal on disconnect", async () => {
    const returned = vi.fn();
    const pending =
      Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
    mocks.stream.mockReturnValue({
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          next: () => {
            if (first) {
              first = false;
              return Promise.resolve({
                done: false,
                value: { type: "start", partial: message() },
              });
            }
            return pending.promise;
          },
          return: returned,
        };
      },
    });
    const response = await handleAnthropicMessages(
      request({ stream: true }),
      provider,
    );
    await response.body?.cancel();
    expect(mocks.stream.mock.calls[0][2].signal.aborted).toBe(true);
    expect(returned).toHaveBeenCalledOnce();
  });
});
