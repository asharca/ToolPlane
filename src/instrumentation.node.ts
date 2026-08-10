// Next.js startup hook. Runs once when the Node server boots to recover MCP
// processes and sandbox data operations that were interrupted by a restart.
export async function registerNode() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const g = globalThis as unknown as {
    __mcpReconciled?: boolean;
    __agentApiMaintenanceTimer?: ReturnType<typeof setInterval>;
    __agentApiIdleMaintenanceTimer?: ReturnType<typeof setInterval>;
  };
  if (g.__mcpReconciled) return;
  g.__mcpReconciled = true;
  const helpersCreatedBefore = new Date();
  // A materializer normally lives for only a few seconds. Unlike the broader
  // sandbox interruption pass, give a just-created stopped helper a grace
  // period so a concurrent launch cannot be mistaken for a crash remnant.
  const deploymentConfigHelpersCreatedBefore = new Date(Date.now() - 10 * 60_000);

  async function reconcileDeploymentConfigHelpers(attempt = 1): Promise<void> {
    try {
      const { removeStaleDeploymentConfigMaterializerHelpers } = await import(
        '@/lib/process/deployment-config-volume'
      );
      const removed = await removeStaleDeploymentConfigMaterializerHelpers(
        deploymentConfigHelpersCreatedBefore,
      );
      if (removed > 0) {
        console.warn(`[mcp] cleaned ${removed} stale deployment configuration materializer helper(s)`);
      }
    } catch (error) {
      console.error(`[mcp] deployment configuration helper reconcile attempt ${attempt} failed`, error);
      if (attempt < 3) {
        const retry = setTimeout(() => {
          void reconcileDeploymentConfigHelpers(attempt + 1);
        }, attempt * 5_000);
        retry.unref?.();
      }
    }
  }

  async function reconcileSandboxCopies(attempt = 1): Promise<void> {
    try {
      const { reconcileSandboxVolumeCopies } = await import('@/lib/sandboxes/reconcile');
      const copies = await reconcileSandboxVolumeCopies({ helpersCreatedBefore });
      if (Object.values(copies).some((count) => count > 0)) {
        console.warn(
          `[mcp] cleaned ${copies.helpersRemoved} stale volume helper(s) and `
          + `${copies.hermesArchiveHelpersRemoved} stale Hermes import helper(s); `
          + `marked ${copies.copiesInterrupted} clone(s), ${copies.restoresInterrupted} restore(s), `
          + `${copies.upgradesInterrupted} image upgrade(s), and ${copies.snapshotsInterrupted} snapshot(s) as interrupted`,
        );
      }
    } catch (error) {
      console.error(`[mcp] sandbox volume reconcile attempt ${attempt} failed`, error);
      if (attempt < 3) {
        const retry = setTimeout(() => {
          void reconcileSandboxCopies(attempt + 1);
        }, attempt * 5_000);
        retry.unref?.();
      }
    }
  }

  try {
    const { ensureConnectorBroker } = await import('@/lib/sandboxes/connector-broker');
    await ensureConnectorBroker();
    const { ensureSandboxNetwork } = await import('@/lib/process/supervisor');
    await ensureSandboxNetwork();
    const { cleanupHermesArchiveStaging } = await import('@/lib/agents/hermes/archive');
    await cleanupHermesArchiveStaging();
    await reconcileDeploymentConfigHelpers();
    await reconcileSandboxCopies();
    const { reconcileDeployments } = await import('@/lib/process/reconcile');
    const n = await reconcileDeployments();
    if (n > 0) console.log(`[mcp] reconciled ${n} deployment(s) on startup`);
  } catch (error) {
    console.error('[mcp] startup reconcile failed', error);
  }

  if (!g.__agentApiMaintenanceTimer) {
    let running = false;
    const maintain = async () => {
      if (running) return;
      running = true;
      try {
        const { runAgentApiMaintenance } = await import('@/lib/agents/public-api/maintenance');
        const result = await runAgentApiMaintenance();
        if (Object.values(result).some((count) => count > 0)) {
          console.log(
            `[agent-api] retained-data cleanup removed ${result.conversations} conversation(s), `
            + `${result.runs} response(s), ${result.runtimes} runtime(s), and `
            + `${result.usageBuckets} usage bucket(s)`,
          );
        }
      } catch (error) {
        console.error('[agent-api] retained-data cleanup failed', error);
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => { void maintain(); }, 30_000);
    first.unref?.();
    g.__agentApiMaintenanceTimer = setInterval(() => { void maintain(); }, 60 * 60_000);
    g.__agentApiMaintenanceTimer.unref?.();
  }
  if (!g.__agentApiIdleMaintenanceTimer) {
    let idleRunning = false;
    const stopIdleRuntimes = async () => {
      if (idleRunning) return;
      idleRunning = true;
      try {
        const { runAgentApiIdleRuntimeMaintenance } = await import(
          '@/lib/agents/public-api/maintenance'
        );
        const stopped = await runAgentApiIdleRuntimeMaintenance();
        if (stopped > 0) {
          console.log(`[agent-api] stopped ${stopped} idle public runtime(s)`);
        }
      } catch (error) {
        console.error('[agent-api] idle runtime cleanup failed', error);
      } finally {
        idleRunning = false;
      }
    };
    const firstIdleStop = setTimeout(() => { void stopIdleRuntimes(); }, 60_000);
    firstIdleStop.unref?.();
    g.__agentApiIdleMaintenanceTimer = setInterval(() => {
      void stopIdleRuntimes();
    }, 60_000);
    g.__agentApiIdleMaintenanceTimer.unref?.();
  }
}
