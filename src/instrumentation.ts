// Next.js startup hook. Runs once when the Node server boots — used to bring MCP
// child processes back up after a restart (the supervisor's process table is
// in-memory and is lost on restart, but the DB still says they're running).
export async function register() {
  // Only in the Node.js server runtime, and never during `next build` (which
  // would spawn child processes that then get orphaned).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const g = globalThis as unknown as { __mcpReconciled?: boolean };
  if (g.__mcpReconciled) return;
  g.__mcpReconciled = true;

  try {
    const { reconcileDeployments } = await import('@/lib/process/reconcile');
    const n = await reconcileDeployments();
    if (n > 0) console.log(`[mcp] reconciled ${n} deployment(s) on startup`);
  } catch (err) {
    console.error('[mcp] startup reconcile failed', err);
  }
}
