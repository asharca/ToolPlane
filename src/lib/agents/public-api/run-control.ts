import 'server-only';

type ActiveRun = {
  controller: AbortController;
  startedAt: number;
};

declare global {
  var __toolplaneAgentApiRuns: Map<string, ActiveRun> | undefined;
}

function activeRuns(): Map<string, ActiveRun> {
  return globalThis.__toolplaneAgentApiRuns ??= new Map();
}

export function registerAgentApiRun(runId: string, controller: AbortController): () => void {
  activeRuns().set(runId, { controller, startedAt: Date.now() });
  return () => {
    const active = activeRuns().get(runId);
    if (active?.controller === controller) activeRuns().delete(runId);
  };
}

export function abortAgentApiRun(runId: string): boolean {
  const active = activeRuns().get(runId);
  if (!active) return false;
  active.controller.abort(new DOMException('The response was cancelled.', 'AbortError'));
  return true;
}

export function activeAgentApiRunCount(): number {
  return activeRuns().size;
}
