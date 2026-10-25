// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  work: vi.fn(),
  port: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    agentRuntime: { findFirst: mocks.runtime },
    workSession: { findFirst: mocks.work },
  },
}));
vi.mock("@/lib/process/supervisor", () => ({ livePort: mocks.port }));
import { stopHermesWorkRun } from "@/lib/agents/hermes/work";
const input = {
  agent: {
    id: "agent",
    workspaceId: "workspace",
    runtime: { id: "runtime", kind: "hermes" },
  },
  runId: "old/run",
};
describe("bound retired Hermes Work cancellation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.runtime.mockResolvedValue({
      sandbox: { deploymentId: "old-deployment" },
    });
    mocks.work.mockResolvedValue({ id: "old-work" });
    mocks.port.mockReturnValue(4000);
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("cancels only a persisted old run on its already-running process", async () => {
    await expect(stopHermesWorkRun(input)).resolves.toBe(true);
    expect(mocks.runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "runtime",
          agentId: "agent",
          workspaceId: "workspace",
          kind: "hermes",
        },
      }),
    );
    expect(mocks.work).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace",
          agentId: "agent",
          runtimeKind: "hermes",
          runtimeSnapshot: { path: ["hermesRunId"], equals: "old/run" },
        }),
      }),
    );
    expect(mocks.port).toHaveBeenCalledWith("old-deployment");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/hermes/v1/runs/old%2Frun/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("never uses a caller-selected run without persisted ownership", async () => {
    mocks.work.mockResolvedValue(null);
    await expect(stopHermesWorkRun(input)).resolves.toBe(false);
    expect(mocks.port).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not resume or boot a stopped old runtime", async () => {
    mocks.port.mockReturnValue(null);
    await expect(stopHermesWorkRun(input)).resolves.toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not cancel through a different or missing runtime", async () => {
    mocks.runtime.mockResolvedValue(null);
    await expect(stopHermesWorkRun(input)).resolves.toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(["pi-sdk", "pi", "hermes-rpc"])(
    "does not dispatch %s through Hermes cancellation",
    async (kind) => {
      await expect(
        stopHermesWorkRun({
          ...input,
          agent: { ...input.agent, runtime: { id: "runtime", kind } },
        }),
      ).resolves.toBe(false);
      expect(mocks.runtime).not.toHaveBeenCalled();
    },
  );
  it("reports an unknown or rejected cancellation without replay", async () => {
    mocks.fetch.mockRejectedValue(new Error("lost connection"));
    await expect(stopHermesWorkRun(input)).resolves.toBe(false);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
