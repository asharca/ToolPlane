import 'server-only';
import { db } from '@/lib/db';
import { killMany } from '@/lib/process/supervisor';

export async function workspaceDeploymentIds(workspaceId: string): Promise<string[]> {
  const rows = await db.deployment.findMany({ where: { workspaceId }, select: { id: true } });
  return rows.map((d) => d.id);
}

// Kill any running MCP child processes for a workspace before it is deleted,
// so no orphaned processes are leaked.
export async function killWorkspaceProcesses(workspaceId: string): Promise<void> {
  killMany(await workspaceDeploymentIds(workspaceId));
}
