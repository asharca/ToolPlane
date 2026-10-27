// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeOwnershipState,
  RuntimeUnavailableError,
  ownership,
  runtimeRequest,
  runtimeRequestUnavailable,
} from "@/lib/runtime/ownership-state";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  ownership.status = "idle";
  expect(ownership.pending).toBe(0);
});
describe("runtime ownership state", () => {
  it("does not serve execution before recovery; maintenance authority is asynchronous-context scoped", async () => {
    const state = new RuntimeOwnershipState();
    expect(() => state.assert()).toThrow(RuntimeUnavailableError);
    state.status = "recovering";
    await state.maintenance.run(true, async () => {
      await Promise.resolve();
      expect(state.canOperate()).toBe(true);
    });
    expect(state.canOperate()).toBe(false);
    state.ready();
    expect(state.canOperate()).toBe(true);
  });
  it("tracks nested operations and releases counts even on errors", async () => {
    const state = new RuntimeOwnershipState();
    state.status = "ready";
    await expect(
      state.run(async () => {
        expect(state.pending).toBe(1);
        await state.run(async () => {
          expect(state.pending).toBe(2);
        });
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(state.pending).toBe(0);
    const release = state.enter();
    release();
    release();
    expect(state.pending).toBe(0);
  });
  it("draining admits only explicit cleanup in maintenance context", async () => {
    const state = new RuntimeOwnershipState();
    state.status = "draining";
    expect(state.canOperate(true)).toBe(false);
    await state.maintenance.run(true, async () => {
      expect(state.canOperate()).toBe(false);
      expect(state.canOperate(true)).toBe(true);
    });
    expect(await state.drain(1)).toBe(true);
  });
  it("loss cancels requests and blocks even maintenance cleanup with shared resources", async () => {
    const state = new RuntimeOwnershipState();
    state.status = "ready";
    state.lose();
    expect(state.abort.signal.aborted).toBe(true);
    state.maintenance.run(true, () =>
      expect(state.canOperate(true)).toBe(false),
    );
    expect(() => state.ready()).toThrow();
    expect(await state.drain(1)).toBe(false);
  });
  it("a drain timeout does not pretend external operations have completed", async () => {
    const state = new RuntimeOwnershipState();
    state.status = "ready";
    const release = state.enter();
    state.status = "draining";
    expect(await state.drain(1)).toBe(false);
    expect(state.uncertain).toBe(true);
    expect(state.abort.signal.aborted).toBe(true);
    release();
    expect(await state.drain(1)).toBe(false);
  });
  it("readiness gates mutations while preserving metadata reads and authorized recovery callbacks", async () => {
    vi.stubEnv("TOOLPLANE_TEST_RUNTIME_OWNER", "1");
    ownership.status = "acquiring";
    expect(runtimeRequestUnavailable("/api/v1/agents/[id]/chat", "POST")).toBe(
      true,
    );
    expect(
      runtimeRequestUnavailable("/api/v1/mcp/[id]/terminal/events", "GET"),
    ).toBe(true);
    expect(runtimeRequestUnavailable("/api/v1/mcp/[id]/health", "GET")).toBe(
      false,
    );
    ownership.status = "recovering";
    await runtimeRequest(
      "/api/v1/agent-runtimes/[id]/mcp",
      "POST",
      async () => {
        expect(ownership.pending).toBe(1);
        expect(ownership.canOperate()).toBe(true);
      },
    );
    expect(ownership.canOperate()).toBe(false);
    ownership.status = "ready";
    await runtimeRequest("/api/v1/agents/[id]/chat", "POST", async () =>
      expect(ownership.pending).toBe(1),
    );
  });
});
