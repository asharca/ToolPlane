import { startRuntimeOwner } from "@/lib/runtime/owner";
import { runtimeCanOperate } from "@/lib/runtime/ownership-state";
import { logSystemEvent } from "@/lib/observability/system";
import { maintainLogs } from "@/lib/observability/maintenance";
import { backfillChannelSenderPolicies } from "@/lib/agents/channel-sender-access";
import { stopIdleAgentConversationSandboxes } from "@/lib/agents/conversation-sandbox";
import { runPendingGithubResourceSyncJobs } from "@/lib/plugins/indexer";
import { provisionOfficialPluginSource } from "@/lib/plugins/sources";
import { runPendingAgentPluginSyncs } from "@/lib/plugins/agent-sync";
import {
  startAgentTriggerScheduler,
  stopAgentTriggerScheduler,
} from "@/lib/agents/triggers";
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
    __githubResourceSyncTimer?: NodeJS.Timeout;
  };
  if (g.__mcpReconciled) return;
  await provisionOfficialPluginSource();
  g.__mcpReconciled = true;
  g.__toolplaneStopTimers = () => {
    stopAgentTriggerScheduler();
    for (const timer of [
      g.__logMaintenanceTimer,
      g.__agentConversationMaintenanceTimer,
      g.__githubResourceSyncTimer,
    ]) {
      if (timer) clearInterval(timer);
    }
  };
  if (!g.__logMaintenanceTimer) {
    let running = false;
    const maintain = async () => {
      if (running || !runtimeCanOperate()) return;
      running = true;
      const started = Date.now();
      try {
        const removed = await maintainLogs();
        if (removed > 0)
          logSystemEvent("maintenance.logs.retention", {
            attributes: { removed },
            durationMs: Date.now() - started,
          });
      } catch (error) {
        logSystemEvent("maintenance.logs.retention", {
          error,
          durationMs: Date.now() - started,
        });
      } finally {
        running = false;
      }
    };
    g.__logMaintenanceTimer = setInterval(() => {
      void maintain();
    }, 5 * 60_000);
    g.__logMaintenanceTimer.unref?.();
  }
  if (!g.__githubResourceSyncTimer) {
    const synchronize = async () => {
      if (!runtimeCanOperate()) return;
      const started = Date.now();
      try {
        const processed = await runPendingGithubResourceSyncJobs();
        const synced = await runPendingAgentPluginSyncs();
        if (processed > 0 || synced > 0)
          logSystemEvent("maintenance.plugins.registry", {
            attributes: { processed, synced },
            durationMs: Date.now() - started,
          });
      } catch (error) {
        logSystemEvent("maintenance.plugins.registry", {
          error,
          durationMs: Date.now() - started,
        });
      }
    };
    g.__githubResourceSyncTimer = setInterval(() => {
      void synchronize();
    }, 15_000);
    g.__githubResourceSyncTimer.unref?.();
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
        logSystemEvent("runtime.config_helpers.reconciled", {
          domain: "runtime",
          level: "warn",
          attributes: { removed },
        });
      }
    } catch (error) {
      failed = true;
      logSystemEvent("runtime.config_helpers.reconcile_failed", {
        domain: "runtime",
        error,
        attributes: { attempt },
      });
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
        logSystemEvent("runtime.sandbox_copies.reconciled", {
          domain: "runtime",
          level: "warn",
          attributes: copies,
        });
      }
    } catch (error) {
      failed = true;
      logSystemEvent("runtime.sandbox_copies.reconcile_failed", {
        domain: "runtime",
        error,
        attributes: { attempt },
      });
      if (attempt < 3) {
        const retry = setTimeout(() => {
          if (runtimeCanOperate()) void reconcileSandboxCopies(attempt + 1);
        }, attempt * 5_000);
        retry.unref?.();
      }
    }
  }

  try {
    await backfillChannelSenderPolicies();
    const { reconcileAgentChannelRunners } = await import(
      "@/lib/agents/channel-runtime"
    );
    const restored = await reconcileAgentChannelRunners();
    if (restored > 0)
      logSystemEvent("channel.startup.reconciled", {
        domain: "channel",
        attributes: { restored },
      });
  } catch (error) {
    failed = true;
    logSystemEvent("channel.startup.reconcile_failed", {
      domain: "channel",
      error,
    });
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
      logSystemEvent("runtime.deployments.reconciled", {
        domain: "runtime",
        attributes: { reconciled: n },
      });
  } catch (error) {
    failed = true;
    logSystemEvent("runtime.deployments.reconcile_failed", {
      domain: "runtime",
      error,
    });
  }

  try {
    const { startWorkCoordinator } = await import("@/lib/work/coordinator");
    await startWorkCoordinator();
  } catch (error) {
    failed = true;
    logSystemEvent("runtime.work.reconcile_failed", {
      domain: "runtime",
      error,
    });
  }

  try {
    const { startAgentWorker } = await import("@/lib/agents/execution/worker");
    await startAgentWorker();
    startAgentTriggerScheduler();
  } catch (error) {
    failed = true;
    logSystemEvent("agent.startup.recovery_failed", { domain: "agent", error });
  }

  if (!g.__agentConversationMaintenanceTimer) {
    let idleRunning = false;
    const stopIdleRuntimes = async () => {
      if (idleRunning || !runtimeCanOperate()) return;
      idleRunning = true;
      const started = Date.now();
      try {
        await stopIdleAgentConversationSandboxes();
      } catch (error) {
        logSystemEvent("maintenance.sandboxes.idle_stop_failed", {
          domain: "runtime",
          error,
          durationMs: Date.now() - started,
        });
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
