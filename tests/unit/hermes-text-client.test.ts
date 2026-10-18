import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  deleteHermesSession,
  HermesResponseTooLargeError,
  runHermesText,
  runHermesTextStream,
} from "@/lib/agents/hermes/client";

const mocks = vi.hoisted(() => ({ ready: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  ensureHermesRuntimeReady: mocks.ready,
}));

const agent = {
  id: "agent-1",
  slug: "researcher",
  workspaceId: "workspace-1",
  runtime: { id: "runtime-1", kind: "hermes" },
};
const params = {
  agent,
  messages: [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
  ] as UIMessage[],
  sessionId: "session/one",
  sessionKey: "private-key",
};
function chunks(...values: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const value of values)
          controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    }),
  );
}
const delta = (content: unknown) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("Hermes text and session client boundaries", () => {
  beforeEach(() => {
    mocks.ready.mockResolvedValue({ port: 4312 });
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["plain text", "plain text"],
    [
      [
        { type: "text", text: "first" },
        { type: "image_url" },
        { type: "text" },
        { type: "text", text: " second" },
      ],
      "first second",
    ],
    [null, ""],
  ])(
    "returns assistant text from completion content %j",
    async (content, expected) => {
      mocks.fetch.mockResolvedValue(
        Response.json({ choices: [{ message: { content } }] }),
      );
      await expect(runHermesText(params)).resolves.toBe(expected);
      expect(mocks.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:4312/hermes/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-hermes-session-key": "private-key",
          }),
          body: JSON.stringify({
            messages: [{ role: "user", content: "Hello" }],
            stream: false,
            model: "researcher",
          }),
        }),
      );
    },
  );

  it("rejects non-Hermes agents before accessing the runtime", async () => {
    const invalid = { ...params, agent: { ...agent, runtime: null } };
    await expect(runHermesText(invalid)).rejects.toThrow("not configured");
    await expect(deleteHermesSession(invalid)).rejects.toThrow(
      "not configured",
    );
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["runtime is stopped", undefined])(
    "rejects unavailable runtime with reason %s",
    async (error) => {
      mocks.ready.mockResolvedValue({ error });
      await expect(runHermesText(params)).rejects.toThrow(
        error || "Hermes runtime is unavailable.",
      );
      await expect(deleteHermesSession(params)).rejects.toThrow(
        error || "Hermes runtime is unavailable.",
      );
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [204, true],
    [404, false],
  ])(
    "reports whether DELETE status %i removed a session",
    async (status, expected) => {
      mocks.fetch.mockResolvedValue(new Response(null, { status }));
      const controller = new AbortController();
      await expect(
        deleteHermesSession({
          ...params,
          signal: controller.signal,
          timeoutMs: 500,
        }),
      ).resolves.toBe(expected);
      expect(mocks.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:4312/hermes/api/sessions/session%2Fone",
        expect.objectContaining({
          method: "DELETE",
          headers: {
            "x-hermes-session-id": params.sessionId,
            "x-hermes-session-key": params.sessionKey,
          },
        }),
      );
    },
  );

  it("surfaces bounded upstream error text and falls back for an empty error body", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(" denied ", { status: 403 }),
    );
    await expect(deleteHermesSession(params)).rejects.toThrow("denied");
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await expect(runHermesText(params)).rejects.toThrow(
      "Hermes runtime returned 502.",
    );
    mocks.fetch.mockResolvedValueOnce(new Response(" ", { status: 500 }));
    await expect(
      runHermesTextStream({ ...params, onDelta: vi.fn() }),
    ).rejects.toThrow("Hermes runtime returned 500.");
  });

  it("cancels oversized error bodies and caps displayed error text", async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(5000)));
          },
          cancel,
        }),
        { status: 500 },
      ),
    );
    const error = await runHermesText(params).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toHaveLength(1000);
    expect(cancel).toHaveBeenCalledWith("error body limit exceeded");
  });

  it("uses a status error when reading the upstream error body fails", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("socket reset"));
          },
        }),
        { status: 503 },
      ),
    );
    await expect(runHermesText(params)).rejects.toThrow(
      "Hermes runtime returned 503.",
    );
  });

  it("streams split SSE blocks, text arrays and trailing data without leaking tool output", async () => {
    mocks.fetch.mockResolvedValue(
      chunks(
        ": heartbeat\r\n\r\ndata: invalid\n\n" +
          delta([
            { type: "text", text: "Hello" },
            { type: "tool", text: "secret" },
          ]).slice(0, 20),
        delta([
          { type: "text", text: "Hello" },
          { type: "tool", text: "secret" },
        ]).slice(20),
        delta(null),
        "data: [DONE]\n\n",
        delta(" world").trimEnd(),
      ),
    );
    const onDelta = vi.fn(async () => undefined);
    await expect(runHermesTextStream({ ...params, onDelta })).resolves.toBe(
      "Hello world",
    );
    expect(onDelta.mock.calls).toEqual([["Hello"], [" world"]]);
  });

  it.each([false, true])(
    "enforces the output limit for trailing=%s",
    async (trailing) => {
      const cancel = vi.fn();
      mocks.fetch.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  trailing ? delta("abcd").trimEnd() : delta("abcd"),
                ),
              );
              if (trailing) controller.close();
            },
            cancel,
          }),
        ),
      );
      const onDelta = vi.fn();
      await expect(
        runHermesTextStream({ ...params, maxOutputCharacters: 3, onDelta }),
      ).rejects.toBeInstanceOf(HermesResponseTooLargeError);
      expect(onDelta).not.toHaveBeenCalled();
      if (!trailing) expect(cancel).toHaveBeenCalled();
    },
  );

  it("bounds an unterminated SSE block independently of emitted text", async () => {
    mocks.fetch.mockResolvedValue(chunks(`data: ${"x".repeat(65540)}`));
    await expect(
      runHermesTextStream({
        ...params,
        maxOutputCharacters: 1,
        onDelta: vi.fn(),
      }),
    ).rejects.toThrow("output limit");
  });

  it("cancels the reader if a consumer rejects a delta", async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(delta("text")));
          },
          cancel,
        }),
      ),
    );
    await expect(
      runHermesTextStream({
        ...params,
        onDelta: async () => {
          throw new Error("consumer gone");
        },
      }),
    ).rejects.toThrow("consumer gone");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects an empty successful response stream", async () => {
    mocks.fetch.mockResolvedValue(new Response(null));
    await expect(
      runHermesTextStream({ ...params, onDelta: vi.fn() }),
    ).rejects.toThrow("empty stream");
  });
});
