// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConcurrencySettings } from "@/lib/admin/settings";

const settings = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/admin/settings", () => ({
  getAgentConcurrencySettings: settings.get,
}));

import {
  AgentExecutionBusyError,
  agentExecutionBusy,
  refreshAgentExecutionLimits,
  withAgentExecutionLease,
  withAgentMaintenanceLease,
} from "@/lib/agents/agent-execution-gate";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let limits: AgentConcurrencySettings;
beforeEach(() => {
  limits = { maxPerAgent: 2, maxTotal: 3, source: "database" };
  settings.get.mockReset().mockImplementation(async () => limits);
});

describe("Agent execution admission", () => {
  it("enforces both limits without letting a saturated Agent block another Agent", async () => {
    const started: string[] = [];
    const a = deferred();
    const b = deferred();
    const run = (agentId: string, sessionId: string, hold: Promise<void>) =>
      withAgentExecutionLease({ agentId, sessionId }, async () => {
        started.push(sessionId);
        await hold;
      });
    const initial = [
      run("a", "a1", a.promise),
      run("a", "a2", a.promise),
      run("b", "b1", b.promise),
    ];
    await flush();
    expect(started).toEqual(["a1", "a2", "b1"]);
    const waiting = [
      run("a", "a3", Promise.resolve()),
      run("b", "b2", Promise.resolve()),
    ];
    await flush();
    expect(started).toEqual(["a1", "a2", "b1"]);
    b.resolve();
    await flush();
    expect(started).toEqual(["a1", "a2", "b1", "b2"]);
    a.resolve();
    await Promise.all([...initial, ...waiting]);
    expect(started).toEqual(["a1", "a2", "b1", "b2", "a3"]);
    expect(agentExecutionBusy("a")).toBe(false);
  });

  it("serializes a session, permits nested dispatch, and rejects an inherited child when full", async () => {
    limits.maxPerAgent = 1;
    const hold = deferred();
    const entered = deferred();
    const order: string[] = [];
    const first = withAgentExecutionLease(
      { agentId: "serial", sessionId: "one" },
      async () => {
        await withAgentExecutionLease(
          { agentId: "serial", sessionId: "one" },
          async () => {
            order.push("nested");
          },
        );
        await expect(
          withAgentExecutionLease(
            { agentId: "serial", sessionId: "child", wait: false },
            async () => {
              order.push("child");
            },
          ),
        ).rejects.toBeInstanceOf(AgentExecutionBusyError);
        entered.resolve();
        await hold.promise;
        order.push("first-complete");
      },
    );
    await entered.promise;
    const second = withAgentExecutionLease(
      { agentId: "serial", sessionId: "one" },
      async () => {
        order.push("second");
      },
    );
    await flush();
    expect(order).toEqual(["nested"]);
    hold.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["nested", "first-complete", "second"]);
  });

  it("removes canceled waiters without invoking them and releases failed executions", async () => {
    limits.maxPerAgent = 1;
    const hold = deferred();
    const first = withAgentExecutionLease(
      { agentId: "cancel", sessionId: "one" },
      async () => {
        await hold.promise;
        throw new Error("runner failed");
      },
    );
    const failed = expect(first).rejects.toThrow("runner failed");
    await flush();
    const controller = new AbortController();
    const canceledWork = vi.fn();
    const canceled = withAgentExecutionLease(
      { agentId: "cancel", sessionId: "two", signal: controller.signal },
      canceledWork,
    );
    const rejected = expect(canceled).rejects.toThrow("user canceled");
    controller.abort(new Error("user canceled"));
    await rejected;
    expect(canceledWork).not.toHaveBeenCalled();
    const nextWork = vi.fn(async () => "next completed");
    const next = withAgentExecutionLease(
      { agentId: "cancel", sessionId: "three" },
      nextWork,
    );
    hold.resolve();
    await failed;
    await expect(next).resolves.toBe("next completed");
    expect(agentExecutionBusy("cancel")).toBe(false);
  });

  it("applies lowered and raised limits to queued work without aborting active turns", async () => {
    const one = deferred();
    const two = deferred();
    const first = withAgentExecutionLease(
      { agentId: "resize", sessionId: "one" },
      () => one.promise,
    );
    const second = withAgentExecutionLease(
      { agentId: "resize", sessionId: "two" },
      () => two.promise,
    );
    await flush();
    limits.maxPerAgent = 1;
    const thirdWork = vi.fn(async () => "third");
    const third = withAgentExecutionLease(
      { agentId: "resize", sessionId: "three" },
      thirdWork,
    );
    one.resolve();
    await first;
    await flush();
    expect(thirdWork).not.toHaveBeenCalled();
    expect(agentExecutionBusy("resize")).toBe(true);
    limits.maxPerAgent = 2;
    refreshAgentExecutionLimits();
    await expect(third).resolves.toBe("third");
    two.resolve();
    await second;
  });

  it("keeps maintenance exclusive and refuses admission when settings cannot be read", async () => {
    const hold = deferred();
    const maintenance = withAgentMaintenanceLease(
      "maintenance",
      () => hold.promise,
    );
    const work = vi.fn(async () => "after maintenance");
    const waiting = withAgentExecutionLease(
      { agentId: "maintenance", sessionId: "one" },
      work,
    );
    await flush();
    expect(work).not.toHaveBeenCalled();
    await expect(
      withAgentMaintenanceLease("maintenance", async () => undefined),
    ).rejects.toBeInstanceOf(AgentExecutionBusyError);
    hold.resolve();
    await maintenance;
    await expect(waiting).resolves.toBe("after maintenance");
    settings.get.mockRejectedValueOnce(new Error("database unavailable"));
    const blocked = vi.fn();
    await expect(
      withAgentExecutionLease(
        { agentId: "unavailable", sessionId: "one" },
        blocked,
      ),
    ).rejects.toThrow("database unavailable");
    expect(blocked).not.toHaveBeenCalled();
    expect(agentExecutionBusy("unavailable")).toBe(false);
  });

  it("allows nested maintenance only while the inherited owner is still live", async () => {
    const attempt = deferred();
    const hold = deferred();
    let stale: Promise<void> | undefined;
    const changed: string[] = [];
    await withAgentMaintenanceLease("owner-one", async () => {
      stale = (async () => {
        await attempt.promise;
        await expect(
          withAgentMaintenanceLease("owner-one", async () => {
            changed.push("stale");
          }),
        ).rejects.toBeInstanceOf(AgentExecutionBusyError);
      })();
      await withAgentMaintenanceLease("owner-two", () =>
        withAgentMaintenanceLease("owner-one", async () => {
          changed.push("nested");
        }),
      );
    });
    const replacement = withAgentMaintenanceLease(
      "owner-one",
      () => hold.promise,
    );
    attempt.resolve();
    await stale;
    expect(changed).toEqual(["nested"]);
    hold.resolve();
    await replacement;
    expect(agentExecutionBusy("owner-one")).toBe(false);
  });
});
