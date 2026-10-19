// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runHermesWork,
  stopHermesWorkRun,
  type RunHermesWorkParams,
} from "@/lib/agents/hermes/work";
const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  record: vi.fn(),
}));
vi.mock("@/lib/agents/hermes/runtime", () => ({
  ensureHermesRuntimeReady: mocks.ready,
}));
vi.mock("@/lib/observability/events", () => ({
  observe: async (_meta: unknown, operation: () => Promise<unknown>) =>
    operation(),
  recordEvent: mocks.record,
}));
const params: RunHermesWorkParams = {
  agent: { id: "a", workspaceId: "w", runtime: { id: "r", kind: "hermes" } },
  task: " task ",
  sessionId: "s",
  sessionKey: "k",
  workingDirectory: ".",
};
const capabilities = () =>
  Response.json({
    features: {
      run_submission: true,
      run_events_sse: true,
      run_stop: true,
      run_approval_response: true,
    },
  });
function setup(
  rows: Record<string, unknown>[],
  status?: Record<string, unknown>,
) {
  mocks.fetch
    .mockResolvedValueOnce(capabilities())
    .mockResolvedValueOnce(Response.json({ run_id: "r/1" }))
    .mockResolvedValueOnce(
      new Response(
        rows.map((row) => `data: ${JSON.stringify(row)}\r\n\r\n`).join(""),
      ),
    );
  if (status) mocks.fetch.mockResolvedValueOnce(Response.json(status));
}
describe("Hermes work failure recovery and event normalization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.ready.mockResolvedValue({ port: 4000 });
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [{ agent: { ...params.agent, runtime: null } }, "not configured"],
    [{ task: " " }, "requires a task"],
    [{ sessionId: "" }, "session ID"],
    [{ sessionKey: " " }, "session ID"],
    [{ profile: "../x" }, "Invalid Hermes profile"],
    [{ provider: "p" }, "selected together"],
    [{ model: "m" }, "selected together"],
  ])("validates run prerequisites %j", async (extra, error) => {
    await expect(runHermesWork({ ...params, ...extra })).rejects.toThrow(error);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([{}, { error: "offline" }])(
    "rejects runtime readiness failure %j",
    async (ready) => {
      mocks.ready.mockResolvedValue(ready);
      await expect(runHermesWork(params)).rejects.toThrow(
        ready.error ?? "unavailable",
      );
    },
  );
  it.each(["", "/etc", "../escape", "a\u0000b"])(
    "rejects unsafe working directory %s before run creation",
    async (workingDirectory) => {
      mocks.fetch.mockResolvedValueOnce(capabilities());
      await expect(
        runHermesWork({ ...params, workingDirectory }),
      ).rejects.toThrow(/working directory/);
      expect(mocks.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "/workspace",
    "/opt/data/workspace",
    "/workspace/a",
    "/opt/data/workspace/a",
    "a\\b",
  ])("normalizes workspace alias %s", async (workingDirectory) => {
    setup([{ event: "run.completed", output: "ok" }]);
    await runHermesWork({
      ...params,
      workingDirectory,
      reasoningEffort: "default",
    });
    const body = JSON.parse(String(mocks.fetch.mock.calls[1][1]?.body));
    const suffix = workingDirectory.endsWith("/a")
      ? "/a"
      : workingDirectory === "a\\b"
        ? "/a/b"
        : "";
    expect(body.instructions).toBe(
      `The working directory for this task is /opt/data/workspace${suffix}. Perform and verify the requested work there.`,
    );
    expect(body).not.toHaveProperty("model_options");
  });
  it.each([404, 500, 503])(
    "rejects capability HTTP %s without stopping a nonexistent run",
    async (status) => {
      mocks.fetch.mockResolvedValueOnce(new Response("", { status }));
      await expect(runHermesWork(params)).rejects.toThrow(
        status === 404 ? "v0.20.0" : `returned ${status}`,
      );
      expect(mocks.fetch).toHaveBeenCalledOnce();
    },
  );
  it("reports missing features and absent run ID", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({}));
    await expect(runHermesWork(params)).rejects.toThrow(
      "missing: run_submission, run_events_sse, run_stop, run_approval_response",
    );
    mocks.fetch
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(Response.json({ run_id: 5 }));
    await expect(runHermesWork(params)).rejects.toThrow(
      "did not return a run ID",
    );
  });
  it.each(["failed", "cancelled", "completed"])(
    "recovers terminal %s from status after truncated events",
    async (status) => {
      setup([{ event: "message.delta", delta: "partial" }], {
        status,
        usage: {
          input_tokens: "bad",
          output_tokens: Number.NaN,
          total_tokens: 3,
        },
      });
      const onRunTerminal = vi.fn();
      const result = await runHermesWork({ ...params, onRunTerminal });
      expect(result).toMatchObject({ runId: "r/1", status, text: "partial" });
      if (status === "failed") expect(result.error).toBe("Hermes run failed.");
      if (status === "completed")
        expect(result.usage).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 3,
        });
      expect(onRunTerminal).toHaveBeenCalledOnce();
    },
  );
  it.each(["failed", "cancelled"])(
    "maps direct %s terminal events",
    async (status) => {
      setup([
        { event: "message.delta", delta: "partial" },
        { event: `run.${status}`, error: "" },
      ]);
      expect(await runHermesWork(params)).toMatchObject({
        status,
        text: "partial",
        ...(status === "failed" ? { error: "Hermes run failed." } : {}),
      });
      expect(mocks.fetch).toHaveBeenCalledTimes(3);
    },
  );
  it("normalizes optional subagent telemetry and malformed approval fields", async () => {
    const full = {
      event: "subagent.complete",
      preview: "p",
      goal: "g",
      task_count: 2,
      task_index: 1,
      subagent_id: "sub",
      child_session_id: "child",
      parent_id: "parent",
      depth: 1,
      model: "m",
      tool_count: 3,
      status: "done",
      summary: "s",
      duration_seconds: 2,
      input_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 5,
      api_calls: 6,
      cost_usd: 0.2,
      files_read: 7,
      files_written: 8,
      output_tail: "tail",
    };
    setup([
      { event: "message.delta", delta: 7 },
      { event: "tool.started", preview: 4 },
      { event: "tool.completed", duration: "bad", error: true },
      full,
      { event: "subagent.start" },
      { event: "approval.request", pattern_keys: ["valid", 4], choices: null },
      {
        event: "approval.request",
        pattern_key: "p",
        allow_permanent: true,
        smart_denied: true,
      },
      { event: "run.completed", output: "done" },
    ]);
    mocks.fetch.mockResolvedValue(Response.json({}));
    const onSubagent = vi.fn(),
      onApproval = vi.fn<NonNullable<RunHermesWorkParams["onApproval"]>>(
        async (): Promise<"deny"> => "deny",
      ),
      onToolStarted = vi.fn(),
      onToolCompleted = vi.fn(),
      onMessageDelta = vi.fn();
    await runHermesWork({
      ...params,
      onSubagent,
      onApproval,
      onToolStarted,
      onToolCompleted,
      onMessageDelta,
    });
    expect(onMessageDelta).not.toHaveBeenCalled();
    expect(onToolStarted).toHaveBeenCalledWith({
      runId: "r/1",
      timestamp: 0,
      tool: "",
    });
    expect(onToolCompleted).toHaveBeenCalledWith({
      runId: "r/1",
      timestamp: 0,
      tool: "",
      duration: 0,
      error: true,
    });
    expect(onSubagent.mock.calls[0][0]).toEqual({
      event: "subagent.complete",
      runId: "r/1",
      timestamp: 0,
      preview: "p",
      goal: "g",
      taskCount: 2,
      taskIndex: 1,
      subagentId: "sub",
      childSessionId: "child",
      parentId: "parent",
      depth: 1,
      model: "m",
      toolCount: 3,
      status: "done",
      summary: "s",
      durationSeconds: 2,
      inputTokens: 3,
      outputTokens: 4,
      reasoningTokens: 5,
      apiCalls: 6,
      costUsd: 0.2,
      filesRead: 7,
      filesWritten: 8,
      outputTail: "tail",
    });
    expect(onSubagent.mock.calls[1][0]).toEqual({
      event: "subagent.start",
      runId: "r/1",
      timestamp: 0,
    });
    expect(onApproval.mock.calls[0][0]).toMatchObject({
      patternKeys: ["valid"],
      choices: [],
      allowPermanent: false,
    });
    expect(onApproval.mock.calls[1][0]).toMatchObject({
      patternKey: "p",
      patternKeys: [],
      smartDenied: true,
    });
    expect(JSON.parse(String(mocks.fetch.mock.calls[3][1]?.body))).toEqual({
      choice: "deny",
    });
  });
  it("denies an approval when no handler is installed", async () => {
    setup([{ event: "approval.request" }, { event: "run.completed" }]);
    mocks.fetch.mockResolvedValue(Response.json({}));
    await runHermesWork(params);
    expect(mocks.fetch.mock.calls[3][1]?.body).toBe('{"choice":"deny"}');
  });
  it.each([
    "empty",
    "malformed",
    "pending",
    "status-error",
    "events-error",
    "approval-error",
  ])("stops an unfinished run after %s", async (mode) => {
    if (mode === "pending" || mode === "status-error") {
      setup([], mode === "pending" ? { status: "running" } : undefined);
      if (mode === "status-error")
        mocks.fetch.mockResolvedValueOnce(
          new Response("status failed", { status: 500 }),
        );
    } else {
      mocks.fetch
        .mockResolvedValueOnce(capabilities())
        .mockResolvedValueOnce(Response.json({ run_id: "r/1" }));
      mocks.fetch.mockResolvedValueOnce(
        mode === "empty"
          ? new Response(null)
          : mode === "malformed"
            ? new Response("data: broken\n\n")
            : mode === "events-error"
              ? new Response("events failed", { status: 500 })
              : new Response('data: {"event":"approval.request"}\n\n'),
      );
      if (mode === "approval-error")
        mocks.fetch.mockResolvedValueOnce(
          new Response("approval failed", { status: 403 }),
        );
    }
    mocks.fetch.mockResolvedValue(new Response(null));
    await expect(runHermesWork(params)).rejects.toThrow();
    expect(String(mocks.fetch.mock.calls.at(-1)?.[0])).toMatch(
      /\/r%2F1\/stop$/,
    );
    expect(mocks.fetch.mock.calls.at(-1)?.[1]).not.toHaveProperty("body");
  });
  it("reads comments, DONE markers, primitive JSON and fragmented trailing events", async () => {
    const text =
      ': keepalive\r\n\r\ndata: [DONE]\r\n\r\ndata: null\r\n\r\ndata: 1\r\n\r\ndata: {"event":"run.completed",\r\ndata: "output":"é"}';
    const bytes = new TextEncoder().encode(text);
    mocks.fetch
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(Response.json({ run_id: "r" }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes)
                controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
      );
    expect(await runHermesWork(params)).toMatchObject({
      status: "completed",
      text: "é",
    });
  });
  it("aborts pending approval and stops the run", async () => {
    const abort = new AbortController();
    setup([{ event: "approval.request" }]);
    mocks.fetch.mockResolvedValue(new Response(null));
    await expect(
      runHermesWork({
        ...params,
        signal: abort.signal,
        onApproval: () => {
          abort.abort(new Error("cancelled"));
          return Promise.withResolvers<"allow" | "deny">().promise;
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(String(mocks.fetch.mock.calls.at(-1)?.[0])).toMatch(/\/stop$/);
  });
  it.each([null, { id: "r", kind: "other" }])(
    "does not stop a non-Hermes runtime %j",
    async (runtime) => {
      expect(
        await stopHermesWorkRun({
          agent: { ...params.agent, runtime },
          runId: "r",
        }),
      ).toBe(false);
      expect(mocks.ready).not.toHaveBeenCalled();
    },
  );
  it("treats stop failures as best effort", async () => {
    expect(await stopHermesWorkRun({ agent: params.agent, runId: " " })).toBe(
      false,
    );
    mocks.ready.mockResolvedValueOnce({});
    expect(await stopHermesWorkRun({ agent: params.agent, runId: "r" })).toBe(
      false,
    );
    mocks.ready.mockRejectedValueOnce(new Error("offline"));
    expect(await stopHermesWorkRun({ agent: params.agent, runId: "r" })).toBe(
      false,
    );
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await stopHermesWorkRun({ agent: params.agent, runId: "r" })).toBe(
      false,
    );
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await stopHermesWorkRun({ agent: params.agent, runId: "r" })).toBe(
      true,
    );
  });
});
