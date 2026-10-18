import { beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { agentTool } from "@/lib/agents/agent-tool";
import { runNativeAgent, uiMessagesToPi } from "@/lib/agents/native";
import type { NativeRunOptions } from "@/lib/agents/native";

const mocks = vi.hoisted(() => ({ stream: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/agents/model", () => ({
  buildModel: () => ({
    models: { streamSimple: mocks.stream },
    model: { maxTokens: 100, contextWindow: 1000, name: "model" },
  }),
  providerModelIds: () => ["model"],
}));
vi.mock("@/lib/observability/events", () => ({
  observe: (_metadata: unknown, action: () => unknown) => action(),
  recordEvent: mocks.event,
}));

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function response(
  content: AssistantMessage["content"] = [],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fixture",
    model: "model",
    usage,
    stopReason,
    errorMessage,
    timestamp: 0,
  };
}
function options(): NativeRunOptions {
  return {
    provider: {
      name: "provider",
      format: "openai",
      apiKey: "secret",
      baseUrl: "https://provider.invalid",
    },
    modelId: "model",
    systemPrompt: "system",
    tools: {},
    messages: [],
    maxSteps: 2,
  };
}
function enqueue(message: AssistantMessage) {
  mocks.stream.mockReturnValueOnce({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "text",
        partial: message,
      };
    },
    result: async () => message,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
});

describe("native agent model and tool policies", () => {
  it.each([
    ["error", undefined, "Model request failed."],
    ["error", "upstream denied", "upstream denied"],
    ["aborted", undefined, "Model request aborted."],
    ["aborted", "cancelled", "cancelled"],
  ] as const)(
    "propagates %s model failures",
    async (reason, detail, expected) => {
      enqueue(response([], reason, detail));
      await expect(runNativeAgent(options())).rejects.toThrow(expected);
    },
  );
  it("records thrown streaming failures without disguising their cause", async () => {
    mocks.stream.mockImplementationOnce(() => {
      throw new Error("transport failed");
    });
    await expect(runNativeAgent(options())).rejects.toThrow("transport failed");
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "model.call",
        error: expect.objectContaining({ message: "transport failed" }),
      }),
    );
  });
  it.each([0, Number.NaN])(
    "does not publish invalid context token count %s",
    async (totalTokens) => {
      enqueue({
        ...response([{ type: "text", text: "answer" }]),
        usage: { ...usage, totalTokens },
      });
      const config = { ...options(), onContextUsage: vi.fn() };
      expect(await runNativeAgent(config)).toBe("answer");
      expect(config.onContextUsage).not.toHaveBeenCalled();
    },
  );
  it("bounds output tokens and merges parsed custom payload parameters", async () => {
    enqueue(response());
    await runNativeAgent({
      ...options(),
      modelParameters: {
        maxOutputTokens: 1000,
        topP: 0.7,
        temperature: 0.2,
        customParameters: [
          { name: "structured", type: "json", value: '{"enabled":true}' },
          { name: "seed", type: "number", value: 42 },
        ],
      },
    });
    const config = mocks.stream.mock.calls[0][2];
    expect(config).toMatchObject({ maxTokens: 100, temperature: 0.2 });
    expect(config.onPayload({ model: "model" })).toEqual({
      model: "model",
      top_p: 0.7,
      structured: { enabled: true },
      seed: 42,
    });
    expect(config.onPayload(null)).toBeNull();
    expect(config.onPayload([])).toEqual([]);
  });
  it("rejects invalid custom JSON before requesting the provider", async () => {
    await expect(
      runNativeAgent({
        ...options(),
        modelParameters: {
          customParameters: [{ name: "broken", type: "json", value: "{" }],
        },
      }),
    ).rejects.toThrow('Invalid JSON for custom model parameter "broken"');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it.each([
    "unknown",
    "throw-error",
    "throw-string",
    "semantic-error",
    "semantic-isError",
    "success",
    "circular",
  ])(
    "handles tool outcome %s without losing the next model response",
    async (kind) => {
      enqueue(
        response(
          [
            { type: "text", text: "before " },
            { type: "toolCall", id: "call", name: "action", arguments: {} },
          ],
          "toolUse",
        ),
      );
      enqueue(response([{ type: "text", text: "after" }]));
      const config = options();
      const circular: { self?: unknown } = {};
      circular.self = circular;
      const output =
        kind === "semantic-error"
          ? { error: "denied" }
          : kind === "semantic-isError"
            ? { isError: true }
            : kind === "circular"
              ? circular
              : "ok";
      if (kind !== "unknown")
        config.tools.action = agentTool({
          name: "action",
          description: "Action",
          parameters: Type.Object({}),
          execute: async () => {
            if (kind === "throw-error") throw new Error("tool denied");
            if (kind === "throw-string") throw "tool denied";
            return output;
          },
        });
      config.onToolResult = vi.fn();
      expect(await runNativeAgent(config)).toBe("before after");
      expect(config.onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: "call" }),
        expect.anything(),
        ["unknown", "throw-error", "throw-string"].includes(kind),
      );
      expect(mocks.event).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "tool.call",
          outcome: ["success", "circular"].includes(kind) ? "success" : "error",
        }),
      );
    },
  );
});

describe("native history serialization", () => {
  it("retains runtime file references only with typed nonempty trusted metadata", () => {
    const metadata = [
      undefined,
      "invalid",
      {},
      { toolplane: "invalid" },
      { toolplane: {} },
      { toolplane: { runtimePath: 42 } },
      { toolplane: { runtimePath: " " } },
    ];
    expect(
      uiMessagesToPi(
        metadata.map((providerMetadata) => ({
          role: "user",
          parts: [{ type: "file", filename: "file", providerMetadata }],
        })),
      ),
    ).toEqual([]);
    const output = uiMessagesToPi([
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: " \n report.pdf ",
            providerMetadata: {
              toolplane: { runtimePath: " /workspace/a\nb " },
            },
          },
          {
            type: "file",
            providerMetadata: {
              toolplane: { runtimePath: "/workspace/default" },
            },
          },
        ],
      },
    ]);
    expect(output[0]).toMatchObject({
      content:
        "[Attached file: report.pdf at /workspace/a b]\n[Attached file: file at /workspace/default]",
    });
  });
  it("rejects unsupported roles and incomplete images but accepts image-only user turns", () => {
    const image = { type: "image", data: "base64", mimeType: "image/png" };
    expect(
      uiMessagesToPi([
        { role: "system", parts: [{ type: "text", text: "hidden" }] },
        { role: "assistant", parts: [image] },
        { role: "user", parts: [{ type: "image", data: 1 }] },
      ]),
    ).toEqual([]);
    expect(uiMessagesToPi([{ role: "user", parts: [image] }])[0]).toMatchObject(
      { role: "user", content: [image] },
    );
  });
});
