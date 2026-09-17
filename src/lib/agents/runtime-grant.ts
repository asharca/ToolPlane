import 'server-only';
import { db } from '@/lib/db';
import type { AgentRuntimeTokenPayload } from './runtime-access';
import { isDedicatedSandboxRuntimeKind } from './runtime-kind';

export async function isAgentRuntimeGrantCurrent(
  token: AgentRuntimeTokenPayload,
): Promise<boolean> {
  const agent = await db.agent.findFirst({
    where: {
      id: token.agentId,
      workspaceId: token.workspaceId,
      workspace: { status: 'active' },
      OR: [
        { providerId: token.providerId },
        { modelProviders: { some: { providerId: token.providerId } } },
      ],
    },
    select: {
      runtimeKind: true,
      servers: { select: { deploymentId: true } },
      toolkits: {
        select: { toolkit: { select: { servers: { select: { deploymentId: true } } } } },
      },
      sandboxes: {
        select: {
          sandboxId: true,
          sandbox: { select: { workspaceId: true, kind: true, network: true } },
        },
      },
    },
  });
  const link = agent?.sandboxes[0];
  const currentDeployments = new Set([
    ...(agent?.servers.map((server) => server.deploymentId) ?? []),
    ...(agent?.toolkits.flatMap((entry) => entry.toolkit.servers.map((server) => server.deploymentId)) ?? []),
  ]);
  if (token.collaborationRunId) {
    const run = await db.agentCollaborationRun.findFirst({ where: {
      id: token.collaborationRunId, workspaceId: token.workspaceId, agentId: token.agentId,
      sandboxId: token.sandboxId, providerId: token.providerId, closedAt: null, deadlineAt: { gt: new Date() },
    } });
    if (!run || !await db.agentCollaborationRun.count({ where: { id: run.rootId, workspaceId: token.workspaceId, deadlineAt: { gt: new Date() } } })) return false;
    if (run.parentTaskId && !await db.agentCollaborationTask.count({ where: {
      id: run.parentTaskId, targetAgentId: token.agentId, workspaceId: token.workspaceId,
      state: 'working', cancelRequestedAt: null, deadlineAt: { gt: new Date() },
    } })) return false;
  }
  return Boolean(
    agent
    && isDedicatedSandboxRuntimeKind(agent.runtimeKind)
    && agent.sandboxes.length === 1
    && link?.sandboxId === token.sandboxId
    && link.sandbox.workspaceId === token.workspaceId
    && link.sandbox.kind === 'docker'
    && link.sandbox.network !== 'none'
    && token.deploymentIds.every((deploymentId) => currentDeployments.has(deploymentId)),
  );
}
