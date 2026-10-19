// @vitest-environment node
import type { UIMessageStreamWriter } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeHermesChatStream } from "@/lib/agents/hermes/client";
import type { HermesUIMessage } from "@/lib/agents/hermes/message-segments";
const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  ensureHermesRuntimeReady: mocks.ready,
}));
vi.mock("@/lib/observability/events", () => ({
  observe: async (_meta: unknown, op: () => Promise<unknown>) => op(),
  recordEvent: vi.fn(),
}));
const agent = {
  id: "a",
  slug: "agent",
  workspaceId: "w",
  runtime: { id: "r", kind: "hermes" },
};
const capabilities = () =>
  Response.json({
    features: {
      session_resources: true,
      session_chat_streaming: true,
      session_model_lock: true,
    },
  });
function writer() {
  const write = vi.fn<UIMessageStreamWriter<HermesUIMessage>["write"]>();
  const streamWriter: UIMessageStreamWriter<HermesUIMessage> = {
    write,
    merge: vi.fn(),
    onError: vi.fn(() => "stream failed"),
  };
  return { write, writer: streamWriter };
}
function setup(
  rows: Array<[string, Record<string, unknown>]>,
  stored: unknown = { data: [] },
) {
  mocks.fetch
    .mockResolvedValueOnce(capabilities())
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(
      new Response(
        rows
          .map(
            ([event, data]) =>
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          )
          .join(""),
      ),
    )
    .mockResolvedValueOnce(Response.json(stored));
}
const base = {
  agent,
  conversationId: "c",
  provider: "p",
  model: "m",
  messages: [
    {
      id: "u",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Hi" }],
    },
  ],
};
describe("Hermes session stream state transitions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.ready.mockResolvedValue({ port: 4000 });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("handles tool completion without start and reports each error fallback", async () => {
    setup([
      ["tool.completed", {}],
      ["tool.failed", { error: "explicit" }],
      ["tool.failed", { preview: "preview" }],
      ["tool.failed", {}],
      ["tool.started", { tool_name: "read", args: { file: "a" } }],
      ["tool.completed", { tool_name: "read", result: "result" }],
      ["tool.completed", { tool_name: "read", preview: "fallback" }],
      ["run.completed", { session_id: "new-session" }],
    ]);
    const { write, writer: output } = writer();
    expect(await writeHermesChatStream({ ...base, writer: output })).toEqual({
      runtimeSessionId: "new-session",
    });
    const chunks = write.mock.calls.map(([chunk]) => chunk);
    expect(
      chunks.filter((chunk) => chunk.type === "tool-output-error"),
    ).toMatchObject([
      { errorText: "explicit" },
      { errorText: "preview" },
      { errorText: "Tool failed." },
    ]);
    expect(
      chunks.filter((chunk) => chunk.type === "tool-output-available"),
    ).toMatchObject([
      { output: null },
      { output: "result" },
      { output: "fallback" },
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
  it("alternates reasoning, text, and tools without overlapping open parts", async () => {
    setup([
      ["tool.progress", { delta: "plan" }],
      ["tool.progress", { delta: "more" }],
      ["assistant.delta", { delta: "first" }],
      ["assistant.delta", { delta: "second" }],
      ["tool.progress", {}],
      ["tool.started", { tool_name: " " }],
      ["assistant.delta", { delta: "last" }],
      ["assistant.completed", { content: "not duplicated" }],
    ]);
    const { write, writer: output } = writer();
    await writeHermesChatStream({ ...base, writer: output });
    const chunks = write.mock.calls.map(([chunk]) => chunk);
    expect(
      chunks.filter((chunk) => chunk.type === "reasoning-start"),
    ).toHaveLength(1);
    expect(
      chunks.filter((chunk) => chunk.type === "reasoning-end"),
    ).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "text-start")).toMatchObject(
      [{ id: "hermes-c" }, { id: "hermes-c-1" }],
    );
    expect(chunks.filter((chunk) => chunk.type === "text-end")).toHaveLength(2);
    expect(chunks.filter((chunk) => chunk.type === "text-delta")).toMatchObject(
      [{ delta: "first" }, { delta: "second" }, { delta: "last" }],
    );
  });
  it("writes completed text and collects only nonblank assistant messages after the last user", async () => {
    setup(
      [
        ["assistant.delta", { delta: 4 }],
        ["assistant.completed", { content: "answer", session_id: "session" }],
      ],
      {
        data: [
          { role: "assistant", content: "old" },
          { role: "user", content: "question" },
          { role: "tool", content: "secret" },
          {
            id: "a",
            role: "assistant",
            content: [
              null,
              4,
              { type: "image" },
              { type: "text" },
              { type: "text", text: "part" },
            ],
          },
          { role: "assistant", content: 5 },
          { role: "assistant", content: " " },
          { role: "assistant", content: "final" },
        ],
      },
    );
    const { write, writer: output } = writer();
    await writeHermesChatStream({
      ...base,
      writer: output,
      signal: new AbortController().signal,
    });
    expect(write).toHaveBeenCalledWith({
      type: "text-delta",
      id: "hermes-c",
      delta: "answer",
    });
    expect(write).toHaveBeenCalledWith({
      type: "data-hermes-messages",
      id: "hermes-messages-c",
      data: {
        segments: [
          { id: "a", text: "part" },
          { id: "4", text: "final" },
        ],
      },
    });
  });
  it.each([
    { data: [{ role: "assistant", content: "no user" }] },
    { data: {} },
    {},
  ])("ignores stored history without a user boundary %j", async (stored) => {
    setup([["run.completed", {}]], stored);
    const { write, writer: output } = writer();
    await writeHermesChatStream({ ...base, writer: output });
    expect(write).not.toHaveBeenCalled();
  });
  it.each([" ", "x".repeat(257), "bad\u0001id"])(
    "rejects unsafe returned session %s",
    async (session_id) => {
      setup([["run.completed", { session_id }]]);
      await expect(
        writeHermesChatStream({ ...base, writer: writer().writer }),
      ).rejects.toThrow("invalid session ID");
      expect(mocks.fetch).toHaveBeenCalledTimes(3);
    },
  );
  it.each([{}, { message: "failed" }])(
    "reports runtime error %j",
    async (data) => {
      setup([["error", data]]);
      await expect(
        writeHermesChatStream({ ...base, writer: writer().writer }),
      ).rejects.toThrow(data.message ?? "runtime request failed");
    },
  );
  it("ignores malformed events but requires a terminal event", async () => {
    mocks.fetch
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          'data: {}\n\nevent: other\n\nevent: other\ndata: null\n\nevent: other\ndata: broken\n\nevent: assistant.completed\ndata: {"content":5}\n\n',
        ),
      );
    await expect(
      writeHermesChatStream({ ...base, writer: writer().writer }),
    ).rejects.toThrow("before the turn completed");
  });
  it.each(["empty", "failed"])("rejects %s session stream", async (kind) => {
    mocks.fetch
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(null, { status: kind === "failed" ? 503 : 200 }),
      );
    await expect(
      writeHermesChatStream({ ...base, writer: writer().writer }),
    ).rejects.toThrow(kind === "failed" ? "returned 503" : "empty stream");
  });
  it("requires a user message and rejects failed session creation", async () => {
    mocks.fetch.mockResolvedValueOnce(capabilities());
    await expect(
      writeHermesChatStream({ ...base, messages: [], writer: writer().writer }),
    ).rejects.toThrow("requires a user message");
    mocks.fetch
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(
      writeHermesChatStream({ ...base, writer: writer().writer }),
    ).rejects.toThrow("denied");
  });
});
