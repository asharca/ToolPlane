import "server-only";
import { db } from "@/lib/db";
import { livePort } from "@/lib/process/supervisor";

export type HermesWorkAgent = {
  id: string;
  workspaceId: string;
  runtime: { id: string; kind: string } | null;
};

/** Cancel only a persisted old run on its already-live runtime; never resume it. */
export async function stopHermesWorkRun(params: {
  agent: HermesWorkAgent;
  runId: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const runId = params.runId.trim();
  if (!runId || params.agent.runtime?.kind !== "hermes") return false;
  const runtime = await db.agentRuntime.findFirst({
    where: {
      id: params.agent.runtime.id,
      agentId: params.agent.id,
      workspaceId: params.agent.workspaceId,
      kind: "hermes",
    },
    include: { sandbox: true },
  });
  if (!runtime) return false;
  const work = await db.workSession.findFirst({
    where: {
      workspaceId: params.agent.workspaceId,
      agentId: params.agent.id,
      runtimeKind: "hermes",
      runtimeSnapshot: { path: ["hermesRunId"], equals: runId },
    },
    select: { id: true },
  });
  if (!work) return false;
  const port = livePort(runtime.sandbox.deploymentId);
  if (!port) return false;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/hermes/v1/runs/${encodeURIComponent(runId)}/stop`,
      {
        method: "POST",
        signal: AbortSignal.timeout(params.timeoutMs ?? 15_000),
        cache: "no-store",
      },
    );
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
