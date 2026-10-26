// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortWorkRun,
  finishWorkOutput,
  isWorkRunActive,
  publishWorkActivity,
  publishWorkOutput,
  registerWorkRun,
  startWorkOutput,
  subscribeWorkOutput,
  unregisterWorkRun,
} from "@/lib/work/run-control";

afterEach(() => vi.useRealTimers());

describe("durable Work output replay lifecycle", () => {
  it("removes a throwing listener without interrupting healthy subscribers", () => {
    const broken = vi.fn(() => {
      throw new Error("disconnected");
    });
    const healthy = vi.fn();
    const first = subscribeWorkOutput("listener-isolation", broken);
    const second = subscribeWorkOutput("listener-isolation", healthy);
    startWorkOutput("listener-isolation", {
      startedAt: 42,
      runtimeKind: "pi-sdk",
      modelName: "model",
    });
    publishWorkOutput("listener-isolation", "hello");
    publishWorkOutput("listener-isolation", "");
    finishWorkOutput("listener-isolation");
    finishWorkOutput("listener-isolation");
    expect(broken).toHaveBeenCalledOnce();
    expect(healthy.mock.calls.map(([event]) => event.type)).toEqual([
      "start",
      "delta",
      "done",
    ]);
    expect(healthy.mock.lastCall?.[0].snapshot).toMatchObject({
      text: "hello",
      done: true,
      active: false,
      startedAt: 42,
      runtimeKind: "pi-sdk",
      modelName: "model",
    });
    first.unsubscribe();
    second.unsubscribe();
  });

  it("merges tool updates while keeping already-delivered snapshots immutable", () => {
    startWorkOutput("activity-merge");
    publishWorkActivity("activity-merge", {
      id: "tool",
      type: "tool",
      status: "running",
      toolName: "read",
      input: { path: "file" },
    });
    const before = subscribeWorkOutput("activity-merge", () => undefined);
    before.snapshot.activities[0].toolName = "client mutation";
    publishWorkActivity("activity-merge", {
      id: "tool",
      type: "tool",
      status: "completed",
      output: "contents",
    });
    const after = subscribeWorkOutput("activity-merge", () => undefined);
    expect(after.snapshot.activities).toEqual([
      {
        id: "tool",
        type: "tool",
        status: "completed",
        toolName: "read",
        input: { path: "file" },
        output: "contents",
      },
    ]);
    expect(before.snapshot.activities[0].status).toBe("running");
    before.unsubscribe();
    after.unsubscribe();
    finishWorkOutput("activity-merge");
  });

  it.each(["start", "delta", "activity"])(
    "cancels pending replay expiry when %s arrives",
    (kind) => {
      vi.useFakeTimers();
      const id = `replay-${kind}`;
      startWorkOutput(id, { modelName: "old" });
      publishWorkOutput(id, "old");
      finishWorkOutput(id);
      vi.advanceTimersByTime(30_000);
      if (kind === "start") startWorkOutput(id);
      if (kind === "delta") publishWorkOutput(id, "new");
      if (kind === "activity")
        publishWorkActivity(id, {
          id: "next",
          type: "runtime",
          status: "running",
        });
      vi.advanceTimersByTime(30_001);
      const replay = subscribeWorkOutput(id, () => undefined);
      expect(replay.snapshot).toMatchObject({
        active: true,
        done: false,
        text: kind === "start" ? "" : kind === "delta" ? "oldnew" : "old",
      });
      if (kind === "start") expect(replay.snapshot.modelName).toBeUndefined();
      replay.unsubscribe();
      finishWorkOutput(id);
      vi.advanceTimersByTime(60_000);
      const expired = subscribeWorkOutput(id, () => undefined);
      expect(expired.snapshot).toEqual({
        text: "",
        activities: [],
        active: false,
        done: false,
      });
      expired.unsubscribe();
    },
  );

  it("does not let stale finalization unregister a replacement run", () => {
    const old = new AbortController();
    const replacement = new AbortController();
    registerWorkRun("replacement-run", old);
    registerWorkRun("replacement-run", replacement);
    unregisterWorkRun("replacement-run", old);
    expect(isWorkRunActive("replacement-run")).toBe(true);
    expect(abortWorkRun("replacement-run")).toBe(true);
    expect(replacement.signal.aborted).toBe(true);
    expect(old.signal.aborted).toBe(false);
    unregisterWorkRun("replacement-run", replacement);
    expect(isWorkRunActive("replacement-run")).toBe(false);
    expect(abortWorkRun("replacement-run")).toBe(false);
  });
});
