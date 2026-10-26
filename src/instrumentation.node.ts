import { startRuntimeOwner } from "@/lib/runtime/owner";
import { runtimeCanOperate } from "@/lib/runtime/ownership-state";
import { systemLog } from "@/lib/observability/system";
import { maintainPiPackageSources } from "@/lib/market/pi-package-catalog";
import { stopIdleAgentConversationSandboxes } from "@/lib/agents/conversation-sandbox";
// Next.js startup hook. Runs once when the Node server boots to recover MCP
// processes, channel runners, and sandbox data operations interrupted by a restart.
export async function registerNode() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  await startRuntimeOwner(registerNodeOwned);
}
async function registerNodeOwned() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  let failed = false;
  const g = globalThis as unknown as {
    __toolplaneStopTimers?: () => void;
    __mcpReconciled?: boolean;
    __agentConversationMaintenanceTimer?: NodeJS.Timeout;
    __logMaintenanceTimer?: ReturnType<typeof setInterval>;
    __piPackageSourceMaintenanceTimer?: NodeJS.Timeout;
  };
  if (g.__mcpReconciled) return;
  g.__mcpReconciled = true;
  g.__toolplaneStopTimers = () => {
    for (const timer of [
      g.__logMaintenanceTimer,
      g.__agentConversationMaintenanceTimer,
      g.__piPackageSourceMaintenanceTimer,
    ]) {
      if (timer) clearInterval(timer);
    }
  };
  if (!g.__logMaintenanceTimer) {
    let running = false;
    const maintain = async () => {
      if (running || !runtimeCanOperate()) return;
      running = true;
      try {
        await (await import("@/lib/observability/maintenance")).maintainLogs();
      } catch (error) {
        (await import("@/lib/observability/system")).systemLog(
          "error",
          "Log retention maintenance failed",
          error,
        );
      } finally {
        running = false;
      }
    };
    g.__logMaintenanceTimer = setInterval(() => {
      void maintain();
    }, 5 * 60_000);
    g.__logMaintenanceTimer.unref?.();
  }
  if (!g.__piPackageSourceMaintenanceTimer) {
    let running = false;
    const maintain = async () => {
      if (running || !runtimeCanOperate()) return;
      running = true;
      try {
        await maintainPiPackageSources();
      } catch {
        systemLog("error", "Pi package metadata maintenance failed");
      } finally {
        running = false;
      }
    };
    g.__piPackageSourceMaintenanceTimer = setInterval(() => {
      void maintain();
    }, 5 * 60_000);
    g.__piPackageSourceMaintenanceTimer.unref?.();
  }
  const helpersCreatedBefore = new Date();
  // A materializer normally lives for only a few seconds. Unlike the broader
  // sandbox interruption pass, give a just-created stopped helper a grace
  // period so a concurrent launch cannot be mistaken for a crash remnant.
  const deploymentConfigHelpersCreatedBefore = new Date(
    Date.now() - 10 * 60_000,
  );

  async function reconcileDeploymentConfigHelpers(attempt = 1): Promise<void> {
    try {
      const { removeStaleDeploymentConfigMaterializerHelpers } = await import(
        "@/lib/process/deployment-config-volume"
      );
      const removed = await removeStaleDeploymentConfigMaterializerHelpers(
        deploymentConfigHelpersCreatedBefore,
      );
      if (removed > 0) {
        systemLog(
          "warn",
          `[mcp] cleaned ${removed} stale deployment configuration materializer helper(s)`,
        );
      }
    } catch (error) {
      failed = true;
      systemLog(
        "error",
        `[mcp] deployment configuration helper reconcile attempt ${attempt} failed`,
        error,
      );
      if (attempt < 3) {
        const retry = setTimeout(() => {
          if (runtimeCanOperate())
            void reconcileDeploymentConfigHelpers(attempt + 1);
        }, attempt * 5_000);
        retry.unref?.();
      }
    }
  }

  async function reconcileSandboxCopies(attempt = 1): Promise<void> {
    try {
      const { reconcileSandboxVolumeCopies } = await import(
        "@/lib/sandboxes/reconcile"
      );
      const copies = await reconcileSandboxVolumeCopies({
        helpersCreatedBefore,
      });
      if (Object.values(copies).some((count) => count > 0)) {
        systemLog(
          "warn",
          `[mcp] cleaned ${copies.helpersRemoved} stale volume helper(s); ` +
            `marked ${copies.copiesInterrupted} clone(s), ${copies.restoresInterrupted} restore(s), ` +
            `${copies.upgradesInterrupted} image upgrade(s), and ${copies.snapshotsInterrupted} snapshot(s) as interrupted`,
        );
      }
    } catch (error) {
      failed = true;
      systemLog(
        "error",
        `[mcp] sandbox volume reconcile attempt ${attempt} failed`,
        error,
      );
      if (attempt < 3) {
        const retry = setTimeout(() => {
          if (runtimeCanOperate()) void reconcileSandboxCopies(attempt + 1);
        }, attempt * 5_000);
        retry.unref?.();
      }
    }
  }

  try {
    const { reconcileAgentChannelRunners } = await import(
      "@/lib/agents/channel-runtime"
    );
    const restored = await reconcileAgentChannelRunners();
    if (restored > 0)
      systemLog(
        "info",
        `[agent-channels] restored ${restored} channel(s) on startup`,
      );
  } catch (error) {
    failed = true;
    systemLog("error", "[agent-channels] startup reconcile failed", error);
  }

  try {
    const { ensureConnectorBroker } = await import(
      "@/lib/sandboxes/connector-broker"
    );
    await ensureConnectorBroker();
    const { ensureSandboxNetwork } = await import("@/lib/process/supervisor");
    await ensureSandboxNetwork();
    await reconcileDeploymentConfigHelpers();
    await reconcileSandboxCopies();
    const { reconcileDeployments } = await import("@/lib/process/reconcile");
    const n = await reconcileDeployments();
    if (n > 0)
      systemLog("info", `[mcp] reconciled ${n} deployment(s) on startup`);
  } catch (error) {
    failed = true;
    systemLog("error", "[mcp] startup reconcile failed", error);
  }

  try {
    const { startWorkCoordinator } = await import("@/lib/work/coordinator");
    await startWorkCoordinator();
  } catch (error) {
    failed = true;
    systemLog("error", "[work] startup reconcile failed", error);
  }

  try {
    const { startA2AWorker } = await import("@/lib/a2a/worker");
    await startA2AWorker();
  } catch {
    failed = true;
    systemLog("error", "[a2a] startup recovery failed");
  }

  if (!g.__agentConversationMaintenanceTimer) {
    let idleRunning = false;
    const stopIdleRuntimes = async () => {
      if (idleRunning || !runtimeCanOperate()) return;
      idleRunning = true;
      try {
        await stopIdleAgentConversationSandboxes();
      } catch (error) {
        systemLog(
          "error",
          "[agent] conversation sandbox maintenance failed",
          error,
        );
      } finally {
        idleRunning = false;
      }
    };
    const firstIdleStop = setTimeout(() => {
      void stopIdleRuntimes();
    }, 60_000);
    firstIdleStop.unref?.();
    g.__agentConversationMaintenanceTimer = setInterval(() => {
      void stopIdleRuntimes();
    }, 60_000);
    g.__agentConversationMaintenanceTimer.unref?.();
  }
  if (failed)
    throw new Error(
      "Runtime startup recovery failed; execution remains blocked.",
    );
}
