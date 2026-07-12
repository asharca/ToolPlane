import 'server-only';
import { db } from '@/lib/db';
import { killMany, preventWorkspaceStarts } from '@/lib/process/supervisor';
import { removeDockerSandboxRuntime } from '@/lib/sandboxes/runtime';
import { disconnectConnector } from '@/lib/sandboxes/connector-broker';

export async function workspaceDeploymentIds(workspaceId: string): Promise<string[]> {
  const rows = await db.deployment.findMany({ where: { workspaceId }, select: { id: true } });
  return rows.map((d) => d.id);
}

// Kill any running MCP child processes for a workspace before it is deleted,
// so no orphaned processes are leaked.
export async function killWorkspaceProcesses(workspaceId: string): Promise<void> {
  // Close the workspace before taking the deployment snapshot so concurrent
  // creates in this server process cannot start an ID absent from the snapshot.
  preventWorkspaceStarts(workspaceId);
  const [deploymentIds, sandboxes] = await Promise.all([
    workspaceDeploymentIds(workspaceId),
    db.sandbox.findMany({ where: { workspaceId }, include: { deployment: { select: { installCfg: true } } } }),
  ]);
  // Supervisor teardown joins any pending launch, terminates the child, and
  // drains its ordered status writes before connector authentication is closed.
  await killMany(deploymentIds);
  // Supervisor writes intentionally tolerate rows deleted by other cleanup
  // paths. Workspace deletion needs a strict final write so connector auth is
  // durably inactive before the one-time WebSocket disconnect.
  await db.deployment.updateMany({
    where: { workspaceId },
    data: { status: 'stopped' },
  });
  for (const sandbox of sandboxes) {
    if (sandbox.kind === 'connector') disconnectConnector(sandbox.id, 'workspace deleted');
  }
  await Promise.all(
    sandboxes
      .filter((s) => s.kind === 'docker' || s.kind === 'hermes')
      .map((s) => {
        const cfg = (s.deployment.installCfg ?? {}) as { volumeName?: string };
        return removeDockerSandboxRuntime(s.id, cfg.volumeName);
      }),
  );
}
