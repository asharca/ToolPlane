import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tasks = vi.hoisted(() => ({
  canOperate: vi.fn(),
  log: vi.fn(),
  logs: vi.fn(),
  packages: vi.fn(),
  attachments: vi.fn(),
  api: vi.fn(),
  idle: vi.fn(),
  channels: vi.fn(),
  connector: vi.fn(),
  dashboard: vi.fn(),
  network: vi.fn(),
  helpers: vi.fn(),
  copies: vi.fn(),
  deployments: vi.fn(),
  work: vi.fn(),
  a2a: vi.fn(),
}));
vi.mock("@/lib/runtime/owner", () => ({
  startRuntimeOwner: (recover: () => Promise<void>) => recover(),
}));
vi.mock("@/lib/runtime/ownership-state", () => ({
  runtimeCanOperate: tasks.canOperate,
}));
vi.mock("@/lib/observability/system", () => ({ systemLog: tasks.log }));
vi.mock("@/lib/observability/maintenance", () => ({
  maintainLogs: tasks.logs,
}));
vi.mock("@/lib/market/pi-package-catalog", () => ({
  maintainPiPackageSources: tasks.packages,
}));
vi.mock("@/lib/agents/upload-reservations", () => ({
  maintainAttachmentUploads: tasks.attachments,
}));
vi.mock("@/lib/agents/public-api/maintenance", () => ({
  runAgentApiMaintenance: tasks.api,
  runAgentApiIdleRuntimeMaintenance: tasks.idle,
}));
vi.mock("@/lib/agents/channel-runtime", () => ({
  reconcileAgentChannelRunners: tasks.channels,
}));
vi.mock("@/lib/sandboxes/connector-broker", () => ({
  ensureConnectorBroker: tasks.connector,
}));
vi.mock("@/lib/agents/hermes/dashboard-broker", () => ({
  ensureHermesDashboardBroker: tasks.dashboard,
}));
vi.mock("@/lib/process/supervisor", () => ({
  ensureSandboxNetwork: tasks.network,
}));
vi.mock("@/lib/process/deployment-config-volume", () => ({
  removeStaleDeploymentConfigMaterializerHelpers: tasks.helpers,
}));
vi.mock("@/lib/sandboxes/reconcile", () => ({
  reconcileSandboxVolumeCopies: tasks.copies,
}));
vi.mock("@/lib/process/reconcile", () => ({
  reconcileDeployments: tasks.deployments,
}));
vi.mock("@/lib/work/coordinator", () => ({ startWorkCoordinator: tasks.work }));
vi.mock("@/lib/a2a/worker", () => ({ startA2AWorker: tasks.a2a }));

import { registerNode } from "@/instrumentation.node";

const runtime = globalThis as typeof globalThis & {
  __mcpReconciled?: boolean;
  __toolplaneStopTimers?: () => void;
  __agentApiMaintenanceTimer?: NodeJS.Timeout;
  __agentApiIdleMaintenanceTimer?: NodeJS.Timeout;
  __attachmentMaintenanceTimer?: NodeJS.Timeout;
  __logMaintenanceTimer?: NodeJS.Timeout;
  __piPackageSourceMaintenanceTimer?: NodeJS.Timeout;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PHASE", "");
  for (const task of Object.values(tasks))
    task.mockReset().mockResolvedValue(undefined);
  tasks.canOperate.mockReturnValue(true);
  tasks.channels.mockResolvedValue(0);
  tasks.helpers.mockResolvedValue(0);
  tasks.copies.mockResolvedValue({ helpersRemoved: 0 });
  tasks.deployments.mockResolvedValue(0);
  tasks.api.mockResolvedValue({
    conversations: 0,
    runs: 0,
    runtimes: 0,
    usageBuckets: 0,
  });
  tasks.idle.mockResolvedValue(0);
});

afterEach(() => {
  runtime.__toolplaneStopTimers?.();
  delete runtime.__toolplaneStopTimers;
  delete runtime.__mcpReconciled;
  delete runtime.__agentApiMaintenanceTimer;
  delete runtime.__agentApiIdleMaintenanceTimer;
  delete runtime.__attachmentMaintenanceTimer;
  delete runtime.__logMaintenanceTimer;
  delete runtime.__piPackageSourceMaintenanceTimer;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("owned runtime recovery and maintenance", () => {
  it("skips build-time side effects and does not repeat completed startup recovery", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await registerNode();
    expect(runtime.__mcpReconciled).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.stubEnv("NEXT_PHASE", "");
    await registerNode();
    const timerCount = vi.getTimerCount();
    await registerNode();
    expect(tasks.deployments).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(timerCount);
  });

  it.each(["channels", "connector", "work", "a2a"] as const)(
    "blocks readiness after %s recovery fails",
    async (task) => {
      const error = new Error("recovery unavailable");
      tasks[task].mockRejectedValue(error);
      await expect(registerNode()).rejects.toThrow(
        "Runtime startup recovery failed; execution remains blocked.",
      );
      expect(tasks.log).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("startup"),
        ...(task === "a2a" ? [] : [error]),
      );
      expect(runtime.__toolplaneStopTimers).toBeTypeOf("function");
    },
  );

  it("bounds helper retries and preserves the original cleanup cutoff", async () => {
    tasks.helpers.mockRejectedValue(new Error("helper busy"));
    tasks.copies.mockRejectedValue(new Error("copy busy"));
    await expect(registerNode()).rejects.toThrow("execution remains blocked");
    const cutoff = tasks.helpers.mock.calls[0][0];
    const copiesCutoff = tasks.copies.mock.calls[0][0].helpersCreatedBefore;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tasks.helpers).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tasks.helpers).toHaveBeenCalledTimes(3);
    expect(tasks.copies).toHaveBeenCalledTimes(3);
    expect(tasks.helpers.mock.calls[2][0]).toBe(cutoff);
    expect(tasks.copies.mock.calls[2][0].helpersCreatedBefore).toBe(
      copiesCutoff,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tasks.helpers).toHaveBeenCalledTimes(3);
    expect(tasks.copies).toHaveBeenCalledTimes(3);
  });

  it("does not retry or perform maintenance after ownership is lost", async () => {
    tasks.helpers.mockRejectedValue(new Error("helper busy"));
    tasks.copies.mockRejectedValue(new Error("copy busy"));
    await expect(registerNode()).rejects.toThrow("execution remains blocked");
    tasks.canOperate.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tasks.helpers).toHaveBeenCalledOnce();
    expect(tasks.copies).toHaveBeenCalledOnce();
    for (const task of [
      tasks.logs,
      tasks.packages,
      tasks.attachments,
      tasks.api,
      tasks.idle,
    ])
      expect(task).not.toHaveBeenCalled();
  });

  it("reports nonzero recovery and retention results", async () => {
    tasks.channels.mockResolvedValue(2);
    tasks.helpers.mockResolvedValue(3);
    tasks.copies.mockResolvedValue({
      helpersRemoved: 1,
      copiesInterrupted: 3,
      restoresInterrupted: 4,
      upgradesInterrupted: 5,
      snapshotsInterrupted: 6,
    });
    tasks.deployments.mockResolvedValue(4);
    tasks.api.mockResolvedValue({
      conversations: 1,
      runs: 2,
      runtimes: 3,
      usageBuckets: 4,
    });
    tasks.idle.mockResolvedValue(5);
    await registerNode();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tasks.log).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("restored 2 channel(s)"),
    );
    expect(tasks.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("cleaned 3 stale deployment"),
    );
    expect(tasks.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("6 snapshot(s) as interrupted"),
    );
    expect(tasks.log).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("reconciled 4 deployment(s)"),
    );
    expect(tasks.log).toHaveBeenCalledWith(
      "info",
      expect.stringContaining(
        "1 conversation(s), 2 response(s), 3 runtime(s), and 4 usage bucket(s)",
      ),
    );
    expect(tasks.log).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("stopped 5 idle public runtime(s)"),
    );
  });

  it("releases each maintenance guard after errors and retries on the next interval", async () => {
    const error = new Error("temporary outage");
    for (const task of [
      tasks.logs,
      tasks.packages,
      tasks.attachments,
      tasks.api,
      tasks.idle,
    ])
      task.mockRejectedValueOnce(error);
    await registerNode();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    for (const message of [
      "Log retention maintenance failed",
      "Pi package metadata maintenance failed",
      "Attachment cleanup failed",
      "[agent-api] retained-data cleanup failed",
      "[agent-api] idle runtime cleanup failed",
    ]) {
      expect(
        tasks.log.mock.calls.some(
          (call) => call[0] === "error" && call[1] === message,
        ),
      ).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    for (const task of [
      tasks.logs,
      tasks.packages,
      tasks.attachments,
      tasks.api,
      tasks.idle,
    ])
      expect(task.mock.calls.length).toBeGreaterThan(1);
  });

  it("prevents overlapping maintenance and stopTimers cancels recurring work", async () => {
    const finishes: Array<() => void> = [];
    for (const task of [
      tasks.logs,
      tasks.packages,
      tasks.attachments,
      tasks.api,
      tasks.idle,
    ]) {
      task.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishes.push(resolve);
          }),
      );
    }
    await registerNode();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    for (const task of [
      tasks.logs,
      tasks.packages,
      tasks.attachments,
      tasks.api,
      tasks.idle,
    ])
      expect(task).toHaveBeenCalledOnce();
    runtime.__toolplaneStopTimers?.();
    for (const finish of finishes) finish();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    for (const task of [
      tasks.logs,
      tasks.packages,
      tasks.attachments,
      tasks.api,
      tasks.idle,
    ])
      expect(task).toHaveBeenCalledOnce();
  });
});
