import 'server-only';
import { db } from '@/lib/db';
import { killMany } from '@/lib/process/supervisor';
import { removeDockerSandboxRuntime } from '@/lib/sandboxes/runtime';

export async function workspaceDeploymentIds(workspaceId: string): Promise<string[]> {
  const rows = await db.deployment.findMany({ where: { workspaceId }, select: { id: true } });
  return rows.map((d) => d.id);
}

// Kill any running MCP child processes for a workspace before it is deleted,
// so no orphaned processes are leaked.
export async function killWorkspaceProcesses(workspaceId: string): Promise<void> {
  const [deploymentIds, sandboxes] = await Promise.all([
    workspaceDeploymentIds(workspaceId),
    db.sandbox.findMany({ where: { workspaceId }, include: { deployment: { select: { installCfg: true } } } }),
  ]);
  killMany(deploymentIds);
  await Promise.all(
    sandboxes
      .filter((s) => s.kind === 'docker' || s.kind === 'hermes')
      .map((s) => {
        const cfg = (s.deployment.installCfg ?? {}) as { volumeName?: string };
        return removeDockerSandboxRuntime(s.id, cfg.volumeName);
      }),
  );
}
