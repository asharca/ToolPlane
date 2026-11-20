// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  logSystemEvent: vi.fn(),
  killAttempts: [] as Array<"hang" | "ok">,
}));

vi.mock(import("node:child_process"), async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mocks.spawn,
}));
vi.mock("@/lib/observability/system", () => ({
  logSystemEvent: mocks.logSystemEvent,
}));

import { runTrackedDockerExec } from "@/lib/agents/sandbox-runtime/docker-exec";
import { ownership } from "@/lib/runtime/ownership-state";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    }),
  });
  return child;
}

describe("sandbox exec termination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("TOOLPLANE_TEST_RUNTIME_OWNER", "1");
    ownership.status = "ready";
    ownership.uncertain = false;
    ownership.uncertainReasons.clear();
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = fakeChild();
      if (args.includes("toolplane-kill")) {
        // The CLI of a hanging attempt is killed at its timeout; the daemon
        // keeps running it, which the next attempt observes as settled.
        if (mocks.killAttempts.shift() === "ok")
          queueMicrotask(() => child.emit("close", 0, null));
        else child.kill.mockImplementation(() => true);
      }
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    ownership.status = "idle";
    ownership.uncertain = false;
    ownership.uncertainReasons.clear();
  });

  async function abortTurn() {
    const controller = new AbortController();
    const turn = runTrackedDockerExec({
      container: "toolplane-sandbox-1",
      workdir: "/workspace",
      executable: "node",
      signal: controller.signal,
    });
    const settled = turn.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(10 * 10_100);
    return settled;
  }

  it("does not latch ownership uncertainty when a later stop attempt completes", async () => {
    mocks.killAttempts = ["hang", "hang", "ok"];
    await expect(abortTurn()).resolves.toBe("Sandbox runtime aborted.");
    expect(ownership.uncertain).toBe(false);
    expect(mocks.logSystemEvent).not.toHaveBeenCalled();
  });

  it("latches a named reason when no stop attempt completes", async () => {
    mocks.killAttempts = Array(10).fill("hang");
    await expect(abortTurn()).resolves.toBe("Sandbox runtime aborted.");
    expect(ownership.uncertain).toBe(true);
    expect([...ownership.uncertainReasons]).toEqual([
      "SANDBOX_PROCESS_STOP_UNCONFIRMED",
    ]);
    await vi.waitFor(() =>
      expect(mocks.logSystemEvent).toHaveBeenCalledWith(
        "runtime.owner.uncertain",
        expect.objectContaining({
          errorCode: "SANDBOX_PROCESS_STOP_UNCONFIRMED",
        }),
      ),
    );
  });
});
