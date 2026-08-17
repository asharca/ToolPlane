// Keep Node-only imports out of the Edge instrumentation bundle.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerNode } = await import('./instrumentation.node');
  // Recovering persisted runtimes can take minutes. Let Next accept requests
  // while that work continues in the background.
  void registerNode().catch((error) => {
    console.error('[mcp] startup reconcile failed', error);
  });
}
