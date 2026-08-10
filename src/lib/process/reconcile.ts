import 'server-only';
import { db } from '@/lib/db';
import { startProcess } from './supervisor';
import { resolveSpawnSpec, type DeploymentForSpawn, type SpawnSpec } from './spawn-spec';

type RunningDeployment = DeploymentForSpawn & { id: string };

export type ReconcileDeps = {
  loadRunning: () => Promise<RunningDeployment[]>;
  start: (id: string, spec: SpawnSpec) => Promise<void>;
};

const defaultDeps: ReconcileDeps = {
  loadRunning: async () => {
    const deployments = await db.deployment.findMany({
      where: { status: { in: ['running', 'provisioning'] } },
      include: {
        server: { select: { name: true } },
        sandbox: {
          select: {
            agentRuntime: {
              select: {
                agent: { select: { publicRuntimeAllocation: { select: { id: true } } } },
              },
            },
          },
        },
      },
    });
    // Public Endpoint runtimes are lazy: a request starts them and the idle
    // maintenance pass stops them again. Never eagerly boot every tenant
    // container after an app restart.
    return deployments.filter((deployment) => (
      !deployment.sandbox?.agentRuntime?.agent.publicRuntimeAllocation
    )) as RunningDeployment[];
  },
  start: startProcess,
};

// On server startup the in-memory process table is empty, but the DB may still
// mark deployments as running from before the restart. Re-spawn each so the
// live state matches what the DB (and the UI) claims. startProcess is
// idempotent — a deployment already supervised is skipped — and a spawn failure
// flips that one to 'error' without aborting the rest.
export async function reconcileDeployments(deps: ReconcileDeps = defaultDeps): Promise<number> {
  const deployments = await deps.loadRunning();
  let started = 0;
  for (const d of deployments) {
    try {
      await deps.start(d.id, resolveSpawnSpec(d));
      started += 1;
    } catch {
      // startProcess persists 'error' on failure; keep reconciling the others.
    }
  }
  return started;
}
