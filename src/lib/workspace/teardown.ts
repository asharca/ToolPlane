import 'server-only';
import { db } from '@/lib/db';
import { killMany, preventWorkspaceStarts } from '@/lib/process/supervisor';
import {
  removeDockerSandboxRuntimeStrict,
  removeDockerVolumeStrict,
} from '@/lib/sandboxes/runtime';
import { disconnectConnector } from '@/lib/sandboxes/connector-broker';
import { closeWorkspaceOperations } from './operation-gate';

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
  await closeWorkspaceOperations(workspaceId);
  const [deploymentIds, sandboxes] = await Promise.all([
    workspaceDeploymentIds(workspaceId),
    db.sandbox.findMany({
      where: { workspaceId },
      include: {
        deployment: { select: { installCfg: true } },
        snapshots: { select: { volumeName: true } },
      },
    }),
  ]);
  const sandboxDeploymentIds = new Set(sandboxes.map((sandbox) => sandbox.deploymentId));
  const regularDeploymentIds = deploymentIds.filter((id) => !sandboxDeploymentIds.has(id));
  // Supervisor teardown joins any pending launch, terminates the child, and
  // drains its ordered status writes before connector authentication is closed.
  if (regularDeploymentIds.length > 0) await killMany(regularDeploymentIds);
  if (sandboxDeploymentIds.size > 0) {
    await killMany([...sandboxDeploymentIds], { finalStatus: 'deleting' });
  }
  // Supervisor writes intentionally tolerate rows deleted by other cleanup
  // paths. Workspace deletion needs a strict final write so connector auth is
  // durably inactive before the one-time WebSocket disconnect.
  await db.deployment.updateMany({
    where: {
      workspaceId,
      OR: [
        { source: null },
        { source: { not: 'sandbox' } },
      ],
    },
    data: { status: 'stopped' },
  });
  await db.deployment.updateMany({
    where: { workspaceId, source: 'sandbox' },
    data: { status: 'deleting' },
  });
  for (const sandbox of sandboxes) {
    if (sandbox.kind === 'connector') disconnectConnector(sandbox.id, 'workspace deleted');
  }
  for (const sandbox of sandboxes) {
    for (const snapshot of sandbox.snapshots) {
      await removeDockerVolumeStrict(snapshot.volumeName);
    }
    if (sandbox.kind === 'docker' || sandbox.kind === 'hermes') {
      const cfg = (sandbox.deployment.installCfg ?? {}) as { volumeName?: string };
      await removeDockerSandboxRuntimeStrict(sandbox.id, cfg.volumeName);
    }
  }
}
