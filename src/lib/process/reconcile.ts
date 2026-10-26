import "server-only";
import { db } from "@/lib/db";
import { startProcess } from "./supervisor";
import {
  resolveSpawnSpec,
  type DeploymentForSpawn,
  type SpawnSpec,
} from "./spawn-spec";
import { resolveMcpConnectionSpawnSpec } from "./mcp-credentials";

type RunningDeployment = DeploymentForSpawn & {
  id: string;
  workspaceId?: string;
  sandbox?: {
    config?: unknown;
  } | null;
};

export type ReconcileDeps = {
  loadRunning: () => Promise<RunningDeployment[]>;
  start: (
    id: string,
    spec: SpawnSpec,
    options?: {
      awaitReady?: boolean;
      workspaceId?: string;
    },
  ) => Promise<void>;
  resolve?: (deployment: RunningDeployment) => Promise<SpawnSpec>;
};

const defaultDeps: ReconcileDeps = {
  loadRunning: async () => {
    const deployments = await db.deployment.findMany({
      where: { status: { in: ["running", "provisioning"] } },
      include: {
        server: { select: { name: true } },
        sandbox: {
          select: {
            config: true,
          },
        },
      },
    });
    // Bound legacy Agent runtimes are read-only history, never restart targets.
    // Pi session execution and lazy public endpoints own their own startup.
    return deployments.filter(
      (deployment) => !isReadOnlySandbox(deployment),
    ) as RunningDeployment[];
  },
  start: startProcess,
  resolve: async (deployment) => {
    if (deployment.source === "sandbox") return resolveSpawnSpec(deployment);
    if (!deployment.workspaceId)
      throw new Error("MCP_CREDENTIAL_SCOPE_INVALID");
    return (
      await resolveMcpConnectionSpawnSpec({
        workspaceId: deployment.workspaceId,
        deploymentId: deployment.id,
      })
    ).spec;
  },
};

function isReadOnlySandbox(deployment: RunningDeployment): boolean {
  const config = deployment.sandbox?.config;
  return (
    !!config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "readOnly" in config &&
    config.readOnly === true
  );
}

// On server startup the in-memory process table is empty, but the DB may still
// mark deployments as running from before the restart. Re-spawn each so the
// live state matches what the DB (and the UI) claims. startProcess is
// idempotent — a deployment already supervised is skipped — and a spawn failure
// flips that one to 'error' without aborting the rest.
export async function reconcileDeployments(
  deps: ReconcileDeps = defaultDeps,
): Promise<number> {
  const deployments = await deps.loadRunning();
  let started = 0;
  for (const d of deployments) {
    if (isReadOnlySandbox(d)) continue;
    try {
      const spec = deps.resolve ? await deps.resolve(d) : resolveSpawnSpec(d);
      await deps.start(d.id, spec, {
        awaitReady: false,
        workspaceId: d.workspaceId,
      });
      started += 1;
    } catch {
      // startProcess persists 'error' on failure; keep reconciling the others.
    }
  }
  return started;
}
