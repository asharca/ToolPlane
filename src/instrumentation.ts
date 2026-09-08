// Keep Node-only imports out of the Edge instrumentation bundle.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerNode } = await import('./instrumentation.node');
  // Recovering persisted runtimes can take minutes. Let Next accept requests
  // while that work continues in the background.
  void registerNode().catch(async (error) => {
    const { recordEvent } = await import('@/lib/observability/events');
    await recordEvent({ domain: 'system', eventName: 'startup.reconcile.failed', error });
  });
}

export async function onRequestError(error: unknown, request: { method: string }, context: { routePath: string }) {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recordEvent } = await import('@/lib/observability/events');
  await recordEvent({ domain: 'system', eventName: 'next.request.error', method: request.method, path: context.routePath, error });
}
