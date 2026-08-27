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
