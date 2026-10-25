// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  runtimeUpdate: vi.fn(),
  deploymentUpdate: vi.fn(),
  stopProcess: vi.fn(),
  killProcess: vi.fn(),
  stopContainer: vi.fn(),
  removeRuntime: vi.fn(),
  begin: vi.fn(),
  end: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    agentRuntime: { findFirst: mocks.runtime, updateMany: mocks.runtimeUpdate },
    deployment: { updateMany: mocks.deploymentUpdate },
  },
}));
vi.mock("@/lib/process/supervisor", () => ({
  stopProcess: mocks.stopProcess,
  killProcess: mocks.killProcess,
}));
vi.mock("@/lib/sandboxes/runtime", () => ({
  sandboxVolumeName: (id: string) => `volume-${id}`,
  stopDockerSandboxContainer: mocks.stopContainer,
  removeDockerSandboxRuntimeStrict: mocks.removeRuntime,
}));
vi.mock("@/lib/workspace/operation-gate", () => ({
  beginWorkspaceOperation: mocks.begin,
}));
import {
  cleanupHermesRuntime,
  stopHermesRuntime,
} from "@/lib/agents/hermes/runtime";
const runtime = {
  id: "retired-runtime",
  workspaceId: "workspace",
  agentId: "agent",
  kind: "hermes",
  sandboxId: "sandbox",
  sandbox: { deploymentId: "deployment", deployment: { status: "running" } },
};
describe("retired Hermes runtime drain and explicit cleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.begin.mockReturnValue(mocks.end);
    mocks.runtime.mockResolvedValue(runtime);
  });
  it("stops only the workspace-bound resource and preserves its volume", async () => {
    await stopHermesRuntime("workspace", "agent");
    expect(mocks.runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace", agentId: "agent", kind: "hermes" },
      }),
    );
    expect(mocks.stopProcess).toHaveBeenCalledWith("deployment");
    expect(mocks.stopContainer).toHaveBeenCalledWith("sandbox");
    expect(mocks.removeRuntime).not.toHaveBeenCalled();
    expect(mocks.runtimeUpdate).toHaveBeenCalledWith({
      where: { id: "retired-runtime", workspaceId: "workspace" },
      data: { status: "stopped", lastError: null },
    });
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it.each([
    "copying",
    "copy_failed",
    "restoring",
    "restore_failed",
    "restore_cleanup_required",
    "upgrading",
    "deleting",
  ])("does not interrupt a %s lifecycle transition", async (status) => {
    mocks.runtime.mockResolvedValue({
      ...runtime,
      sandbox: { ...runtime.sandbox, deployment: { status } },
    });
    await stopHermesRuntime("workspace", "agent");
    expect(mocks.stopProcess).not.toHaveBeenCalled();
    expect(mocks.stopContainer).not.toHaveBeenCalled();
  });
  it("allows explicit deletion cleanup without booting a retained runtime", async () => {
    mocks.runtime.mockResolvedValue({
      ...runtime,
      sandbox: { ...runtime.sandbox, deployment: { status: "deleting" } },
    });
    await expect(cleanupHermesRuntime("workspace", "agent")).resolves.toBe(
      true,
    );
    expect(mocks.killProcess).toHaveBeenCalledWith("deployment", {
      preventRestart: true,
      finalStatus: "deleting",
    });
    expect(mocks.removeRuntime).toHaveBeenCalledWith(
      "sandbox",
      "volume-sandbox",
      { timeoutMs: expect.any(Number) },
    );
  });
  it("does not mark cleanup complete when volume deletion fails", async () => {
    mocks.removeRuntime.mockRejectedValue(new Error("volume busy"));
    await expect(cleanupHermesRuntime("workspace", "agent")).rejects.toThrow(
      "volume busy",
    );
    expect(mocks.runtimeUpdate).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it("serializes cleanup after the same Agent's already admitted drain", async () => {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.stopProcess.mockImplementationOnce(async () => {
      markStarted();
      await held;
    });
    const stopped = stopHermesRuntime("workspace", "agent");
    await started;
    const cleaned = cleanupHermesRuntime("workspace", "agent");
    await Promise.resolve();
    expect(mocks.killProcess).not.toHaveBeenCalled();
    release();
    await Promise.all([stopped, cleaned]);
    expect(mocks.killProcess).toHaveBeenCalledOnce();
    expect(mocks.removeRuntime).toHaveBeenCalledOnce();
  });
  it("does nothing for a missing or differently scoped runtime", async () => {
    mocks.runtime.mockResolvedValue(null);
    await stopHermesRuntime("other-workspace", "agent");
    await cleanupHermesRuntime("other-workspace", "agent");
    expect(mocks.stopProcess).not.toHaveBeenCalled();
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.removeRuntime).not.toHaveBeenCalled();
  });
  it("refuses cleanup admission while a workspace is draining", async () => {
    mocks.begin.mockReturnValue(null);
    await expect(
      stopHermesRuntime("workspace", "agent"),
    ).resolves.toBeUndefined();
    await expect(cleanupHermesRuntime("workspace", "agent")).resolves.toBe(
      false,
    );
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
