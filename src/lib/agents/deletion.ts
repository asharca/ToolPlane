import 'server-only';

import { db } from '@/lib/db';
import { cleanupHermesRuntime } from '@/lib/agents/hermes/runtime';
import { deleteAgent, getAgentDeleteTargets } from '@/lib/agents/mutations';
import { cleanupAgentEndpointRuntimesForSource } from '@/lib/agents/public-api/maintenance';
import { isAgentEndpointRuntimeSandboxConfig } from '@/lib/agents/public-api/tool-policy';
import { killProcess } from '@/lib/process/supervisor';
import {
  removeDockerSandboxRuntimeStrict,
  removeDockerVolumeStrict,
} from '@/lib/sandboxes/runtime';

export async function deleteManagedAgent(input: {
  workspaceId: string;
  agentId: string;
  actorId: string;
}) {
  const [workspace, agent] = await Promise.all([
    db.workspace.findFirst({
      where: {
        id: input.workspaceId,
        OR: [{ ownerId: input.actorId }, { members: { some: { userId: input.actorId } } }],
      },
      select: {
        ownerId: true,
        members: {
          where: { userId: input.actorId },
          take: 1,
          select: { role: true },
        },
      },
    }),
    db.agent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      select: {
        publicRuntimeAllocation: { select: { id: true } },
        publicEndpoints: { take: 1, select: { id: true } },
        runtime: { select: { sandbox: { select: { config: true } } } },
      },
    }),
  ]);
  if (
    !workspace
    || !agent
    || agent.publicRuntimeAllocation
    || isAgentEndpointRuntimeSandboxConfig(agent.runtime?.sandbox.config)
  ) return false;
  if (
    agent.publicEndpoints.length > 0
    && workspace.ownerId !== input.actorId
    && workspace.members[0]?.role !== 'admin'
  ) return false;
  if (!await cleanupAgentEndpointRuntimesForSource(input.workspaceId, input.agentId)) return false;

  const targets = await getAgentDeleteTargets(input.workspaceId, input.agentId);
  for (const targetId of targets.agentIds) {
    if (!await cleanupHermesRuntime(input.workspaceId, targetId)) return false;
  }
  for (const sandbox of targets.sandboxes) {
    if (sandbox.kind !== 'docker') continue;
    await killProcess(sandbox.deploymentId, { preventRestart: true, finalStatus: 'deleting' });
    for (const volumeName of sandbox.snapshotVolumeNames) await removeDockerVolumeStrict(volumeName);
    await removeDockerSandboxRuntimeStrict(sandbox.id, sandbox.volumeName);
  }
  await deleteAgent(input.workspaceId, input.agentId);
  return true;
}
