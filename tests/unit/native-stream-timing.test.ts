// @vitest-environment node
import { expect, it, vi } from "vitest";
import { runNativeAgent } from "@/lib/agents/native";
import { createNativeUiStreamBridge } from "@/lib/agents/ui-stream";

it("forwards provider text before completion", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const encoder = new TextEncoder();
  const chunks: unknown[] = [];
  const bridge = createNativeUiStreamBridge(
    {
      write(chunk) {
        chunks.push(chunk);
      },
    },
    "timing",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
  const run = runNativeAgent({
    provider: {
      name: "Test",
      format: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "test",
    },
    modelId: "gpt-x",
    systemPrompt: "",
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    tools: {},
    maxSteps: 1,
    onEvent: bridge.onEvent,
  });
  try {
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: "reply", model: "gpt-x", choices: [{ index: 0, delta: { content: "first" }, finish_reason: null }] })}\n\n`,
      ),
    );
    await vi.waitFor(() =>
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: "text-delta", delta: "first" }),
      ),
    );
  } finally {
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: "reply", model: "gpt-x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      ),
    );
    controller.close();
    await expect(run).resolves.toBe("first");
    vi.unstubAllGlobals();
  }
});
