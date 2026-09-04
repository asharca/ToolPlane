import 'server-only';
import { db } from '@/lib/db';
import { isAgentEndpointRuntimeSandboxConfig } from '@/lib/agents/public-api/tool-policy';

export async function listSandboxes(workspaceId: string) {
  return db.sandbox.findMany({
    where: { workspaceId, kind: { not: 'hermes' } },
    orderBy: { createdAt: 'desc' },
    include: { deployment: true, _count: { select: { agentLinks: true, snapshots: true } } },
  });
}

export async function listManagedAgentRuntimes(workspaceId: string) {
  const runtimes = await db.agentRuntime.findMany({
    where: {
      workspaceId,
      kind: 'hermes',
      agent: { publicRuntimeAllocation: { is: null } },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      image: true,
      status: true,
      lastError: true,
      lastSyncedAt: true,
      agent: {
        select: { id: true, name: true },
      },
      sandbox: {
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          config: true,
          deploymentId: true,
          deployment: { select: { status: true } },
          snapshots: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              name: true,
              status: true,
              error: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });
  return runtimes.filter((runtime) => (
    !isAgentEndpointRuntimeSandboxConfig(runtime.sandbox.config)
  ));
}

export async function getSandbox(workspaceId: string, sandboxId: string) {
  return db.sandbox.findFirst({
    where: { id: sandboxId, workspaceId, kind: { not: 'hermes' } },
    include: {
      deployment: true,
      agentLinks: { include: { agent: { select: { id: true, name: true } } } },
      snapshots: { orderBy: { createdAt: 'desc' } },
    },
  });
}
