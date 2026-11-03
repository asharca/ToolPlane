// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createWorkCompletionTransition } from "@/components/dashboard/work/completion-transition";

describe("Work completion notification transitions", () => {
  it("never rings for historical or reconnect-completed snapshots", () => {
    const completion = createWorkCompletionTransition();
    expect(
      completion.observe("snapshot", {
        startedAt: 100,
        active: false,
        done: true,
      }),
    ).toBeNull();
    expect(
      completion.observe("done", {
        startedAt: 100,
        active: false,
        done: true,
      }),
    ).toBeNull();

    completion.observe("start", { startedAt: 200, active: true, done: false });
    completion.disconnect();
    completion.observe("snapshot", {
      startedAt: 200,
      active: false,
      done: true,
    });
    expect(
      completion.observe("done", {
        startedAt: 200,
        active: false,
        done: true,
      }),
    ).toBeNull();
  });

  it("rings only once for each continuously observed live turn", () => {
    const completion = createWorkCompletionTransition();
    completion.observe("snapshot", {
      startedAt: 100,
      active: true,
      done: false,
    });
    expect(
      completion.observe("done", {
        startedAt: 100,
        active: false,
        done: true,
      }),
    ).toBe(100);
    expect(
      completion.observe("done", {
        startedAt: 100,
        active: false,
        done: true,
      }),
    ).toBeNull();
    completion.observe("snapshot", {
      startedAt: 100,
      active: true,
      done: false,
    });
    expect(
      completion.observe("done", {
        startedAt: 100,
        active: false,
        done: true,
      }),
    ).toBeNull();

    completion.observe("start", { startedAt: 200, active: true, done: false });
    expect(
      completion.observe("done", {
        startedAt: 200,
        active: false,
        done: true,
      }),
    ).toBe(200);
  });

  it("requires matching valid turn identity and never catches up across a gap", () => {
    const completion = createWorkCompletionTransition();
    completion.observe("start", { startedAt: 100, active: true, done: false });
    expect(
      completion.observe("done", {
        startedAt: 200,
        active: false,
        done: true,
      }),
    ).toBeNull();
    completion.observe("start", { active: true });
    expect(
      completion.observe("done", { active: false, done: true }),
    ).toBeNull();
    completion.observe("start", { startedAt: Number.NaN, active: true });
    expect(
      completion.observe("done", {
        startedAt: Number.NaN,
        active: false,
        done: true,
      }),
    ).toBeNull();
    completion.observe("start", { startedAt: 300, active: true, done: false });
    completion.disconnect();
    expect(
      completion.observe("done", {
        startedAt: 300,
        active: false,
        done: true,
      }),
    ).toBeNull();

    // A reconnect still observing a running turn may ring for its future end.
    completion.observe("snapshot", {
      startedAt: 400,
      active: true,
      done: false,
    });
    expect(
      completion.observe("done", {
        startedAt: 400,
        active: false,
        done: true,
      }),
    ).toBe(400);
  });
});
