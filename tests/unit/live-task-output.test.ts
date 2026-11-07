// @vitest-environment node
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertDefined } from "../assert-defined";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { Task, TaskState } from "@a2a-js/sdk";
import type { A2ATask } from "@prisma/client";
import {
  startTaskOutput,
  configureTaskOutput,
  publishTaskActivity,
  publishTaskStage,
  publishTaskText,
  finishTaskOutput,
  taskOutput,
  notifyTaskOutput,
} from "@/lib/agents/execution/live-output";
import {
  executionOutputResponse,
  type Observation,
} from "@/lib/agents/execution/live-output-stream";
import { readTaskOutput } from "@/lib/agents/execution/live-output-read";
import { revokeWorkspaceStreams } from "@/lib/workspace/access-stream";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const decoder = new TextDecoder();
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  if (result.done) return null;
  const text = decoder.decode(result.value);
  return {
    event: /^event: (.+)$/m.exec(text)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? "null"),
  };
}
function observation(taskId: string, settled = false): Observation {
  return {
    workspaceId: "workspace",
    userId: "user",
    output: taskOutput(taskId),
    settled,
  };
}
describe("task-scoped native live capture", () => {
  it("bounds replay, redacts credentials, preserves terminal cancellation and ignores late callbacks", () => {
    const id = randomUUID();
    startTaskOutput(id);
    configureTaskOutput(id, ["fixture-private-runtime-token"], "fixture");
    publishTaskText(id, "Result fixture-private-runtime-token ");
    publishTaskText(id, "x".repeat(100_000));
    for (let index = 0; index < 90; index++)
      publishTaskActivity(id, {
        type: "tool",
        status: "running",
        toolCallId: `t${index}`,
        toolName: "bash",
        input: { token: "must-not-escape", command: "printf safe" },
        output: "z".repeat(10_000),
      });
    publishTaskStage(id, "tool-running");
    const active = taskOutput(id);
    expect(active?.active).toBe(true);
    expect(active?.text.length).toBeLessThanOrEqual(65_536);
    expect(active?.truncated).toBe(true);
    expect(active?.activities.length).toBeLessThanOrEqual(48);
    expect(
      active?.activities.every(
        (activity) =>
          typeof activity.output === "string" && activity.output.endsWith("…"),
      ),
    ).toBe(true);
    expect(JSON.stringify(active)).not.toContain("must-not-escape");
    expect(JSON.stringify(active)).not.toContain(
      "fixture-private-runtime-token",
    );
    finishTaskOutput(id, "cancelled");
    publishTaskText(id, "late");
    publishTaskActivity(id, {
      type: "tool",
      status: "completed",
      toolCallId: "t89",
    });
    expect(taskOutput(id)).toMatchObject({ active: false, done: true });
    expect(
      taskOutput(id)?.activities.every(
        (activity) => activity.status === "cancelled",
      ),
    ).toBe(true);
    expect(taskOutput(id)?.text).not.toContain("late");
    vi.advanceTimersByTime(60_001);
    expect(taskOutput(id)).toBeNull();
    const reasoningId = randomUUID();
    startTaskOutput(reasoningId);
    publishTaskActivity(reasoningId, {
      type: "reasoning",
      status: "running",
      delta: "r".repeat(10_000),
    });
    expect(taskOutput(reasoningId)?.activities[0]?.text?.endsWith("…")).toBe(
      true,
    );
    finishTaskOutput(reasoningId, "completed");
  });
  it("recovers committed partial output without a process-local capture and never trusts remote tool metadata", () => {
    const id = randomUUID();
    const snapshot = Task.toJSON(
      Task.fromJSON({
        id,
        contextId: "ctx",
        status: { state: "TASK_STATE_FAILED" },
        artifacts: [
          { artifactId: "a", parts: [{ text: "observed remote artifact" }] },
        ],
        metadata: {
          toolplaneLiveOutput: {
            taskId: id,
            text: "partial native output",
            startedAt: 123,
            activities: [
              {
                id: "tool:x",
                type: "tool",
                status: "failed",
                toolName: "bash",
                output: "native error",
              },
            ],
          },
        },
      }),
    );
    const row = {
      id,
      snapshot,
      state: TaskState.TASK_STATE_FAILED,
      phase: "done",
      createdAt: new Date(),
      executionBackend: "pi-sdk",
      uiProjection: {},
      grant: { kind: "local" },
    } as unknown as A2ATask;
    expect(readTaskOutput(row)).toMatchObject({
      text: "partial native output",
      active: false,
      done: true,
      activities: [
        { toolName: "bash", status: "failed", output: "native error" },
      ],
    });
    row.grant = { kind: "remote" } as A2ATask["grant"];
    const remote = readTaskOutput(row);
    expect(remote.activities).toEqual([]);
    expect(remote.text).toBe("observed remote artifact");
  });
  it("does not reuse a retained done snapshot when the same task is queued for another input", () => {
    const id = randomUUID();
    startTaskOutput(id);
    publishTaskText(id, "old turn");
    finishTaskOutput(id, "completed");
    const row = {
      id,
      state: TaskState.TASK_STATE_SUBMITTED,
      phase: "queued",
      createdAt: new Date(),
      snapshot: Task.toJSON(
        Task.fromJSON({ id, status: { state: "TASK_STATE_SUBMITTED" } }),
      ),
      grant: { kind: "local" },
      uiProjection: { executionStage: "tool-running" },
      executionBackend: "pi-sdk",
    } as unknown as A2ATask;
    expect(readTaskOutput(row)).toMatchObject({
      text: "",
      active: true,
      done: false,
      executionStage: "queued",
    });
  });
});
describe("bounded observation SSE", () => {
  it("streams callback snapshots before completion without token-driven persistence reads, then waits for durable history", async () => {
    const id = randomUUID();
    startTaskOutput(id);
    let persisted = false;
    const load = vi.fn(async () => observation(id, persisted));
    const abort = new AbortController();
    const response = executionOutputResponse(
      new Request("http://localhost/events", { signal: abort.signal }),
      observation(id),
      load,
    );
    const reader = assertDefined(response.body).getReader();
    try {
      expect((await frame(reader))?.data.output.active).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
      await frame(reader); // authoritative lookup/subscription race recovery
      for (let index = 0; index < 1000; index++) publishTaskText(id, "a");
      publishTaskActivity(id, {
        type: "tool",
        toolCallId: "native-bash",
        toolName: "bash",
        status: "running",
        input: { command: "sleep 1" },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect((await frame(reader))?.data.output).toMatchObject({
        text: "a".repeat(1000),
        active: true,
        activities: [
          expect.objectContaining({ toolName: "bash", status: "running" }),
        ],
      });
      expect(load).toHaveBeenCalledTimes(1);
      finishTaskOutput(id, "completed");
      await vi.advanceTimersByTimeAsync(50);
      expect((await frame(reader))?.data.output).toMatchObject({
        active: false,
        done: true,
      });
      expect(load).toHaveBeenCalledTimes(2);
      persisted = true;
      notifyTaskOutput(id);
      await vi.advanceTimersByTimeAsync(50);
      expect((await frame(reader))?.event).toBe("snapshot");
      expect(await frame(reader)).toEqual({
        event: "settled",
        data: { taskId: id },
      });
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });
  it("keeps one conversation subscription across turns and recovers late subscribers", async () => {
    const first = randomUUID(),
      second = randomUUID();
    startTaskOutput(first);
    let selected = first;
    const load = vi.fn(async () => observation(selected));
    const abort = new AbortController();
    const response = executionOutputResponse(
      new Request("http://localhost/events", { signal: abort.signal }),
      observation(first),
      load,
      true,
    );
    const reader = assertDefined(response.body).getReader();
    try {
      await frame(reader);
      await vi.advanceTimersByTimeAsync(50);
      await frame(reader);
      selected = second;
      startTaskOutput(second);
      publishTaskText(second, "next turn");
      await vi.advanceTimersByTimeAsync(50);
      expect((await frame(reader))?.data.output).toMatchObject({
        taskId: second,
        text: "next turn",
        active: true,
      });
      const reconnect = executionOutputResponse(
        new Request("http://localhost/events"),
        observation(second),
        load,
        true,
      );
      const late = assertDefined(reconnect.body).getReader();
      expect((await frame(late))?.data.output.text).toBe("next turn");
      await late.cancel();
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });
  it("rechecks the observer session rather than the request publishing a task event", async () => {
    const session = new AsyncLocalStorage<string>();
    const id = randomUUID();
    startTaskOutput(id);
    let permitted = true;
    const response = session.run("observer", () =>
      executionOutputResponse(
        new Request("http://localhost/events"),
        observation(id),
        async () => {
          if (session.getStore() !== "observer" || !permitted)
            throw new TaskNotFoundError();
          return observation(id);
        },
      ),
    );
    const reader = assertDefined(response.body).getReader();
    try {
      await frame(reader);
      await vi.advanceTimersByTimeAsync(50);
      await frame(reader);
      session.run("channel-ingress", () => {
        publishTaskText(id, "observed result");
        finishTaskOutput(id, "completed");
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(await frame(reader)).toMatchObject({
        event: "snapshot",
        data: { output: { text: "observed result", done: true } },
      });
      permitted = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await frame(reader)).toEqual({ event: "revoked", data: {} });
    } finally {
      await reader.cancel();
    }
  });
  it("revokes on continuous task authorization failure and immediately on workspace revocation", async () => {
    const id = randomUUID();
    startTaskOutput(id);
    const load = vi.fn(async () => observation(id));
    const response = executionOutputResponse(
      new Request("http://localhost/events"),
      observation(id),
      load,
    );
    const reader = assertDefined(response.body).getReader();
    await frame(reader);
    await vi.advanceTimersByTimeAsync(50);
    await frame(reader);
    load.mockRejectedValue(new TaskNotFoundError());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await frame(reader)).toEqual({ event: "revoked", data: {} });
    expect((await reader.read()).done).toBe(true);
    const immediate = executionOutputResponse(
      new Request("http://localhost/events"),
      observation(id),
      async () => observation(id),
    );
    const immediateReader = assertDefined(immediate.body).getReader();
    await frame(immediateReader);
    await vi.advanceTimersByTimeAsync(50);
    await frame(immediateReader);
    revokeWorkspaceStreams("workspace", "user");
    expect((await frame(immediateReader))?.event).toBe("revoked");
    await immediateReader.cancel();
  });
  it("cleans up a disconnected reader and never authorizes or submits another execution", async () => {
    const id = randomUUID();
    startTaskOutput(id);
    const load = vi.fn(async () => observation(id));
    const response = executionOutputResponse(
      new Request("http://localhost/events"),
      observation(id),
      load,
    );
    const reader = assertDefined(response.body).getReader();
    await frame(reader);
    await reader.cancel();
    const count = load.mock.calls.length;
    publishTaskText(id, "after disconnect");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(count);
    expect(taskOutput(id)?.active).toBe(true);
  });
});
