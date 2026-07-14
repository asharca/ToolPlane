// Next.js startup hook. Runs once when the Node server boots to recover MCP
// processes and sandbox data operations that were interrupted by a restart.
export async function registerNode() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const g = globalThis as unknown as { __mcpReconciled?: boolean };
  if (g.__mcpReconciled) return;
  g.__mcpReconciled = true;
  const helpersCreatedBefore = new Date();

  async function reconcileSandboxCopies(attempt = 1): Promise<void> {
    try {
      const { reconcileSandboxVolumeCopies } = await import('@/lib/sandboxes/reconcile');
      const copies = await reconcileSandboxVolumeCopies({ helpersCreatedBefore });
      if (Object.values(copies).some((count) => count > 0)) {
        console.warn(
          `[mcp] cleaned ${copies.helpersRemoved} stale volume helper(s); `
          + `marked ${copies.copiesInterrupted} clone(s), ${copies.restoresInterrupted} restore(s), `
          + `and ${copies.snapshotsInterrupted} snapshot(s) as interrupted`,
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
    await reconcileSandboxCopies();
    const { reconcileDeployments } = await import('@/lib/process/reconcile');
    const n = await reconcileDeployments();
    if (n > 0) console.log(`[mcp] reconciled ${n} deployment(s) on startup`);
  } catch (error) {
    console.error('[mcp] startup reconcile failed', error);
  }
}
