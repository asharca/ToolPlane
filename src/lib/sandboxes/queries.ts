import 'server-only';
import { db } from '@/lib/db';

export async function listSandboxes(workspaceId: string) {
  return db.sandbox.findMany({
    where: { workspaceId, kind: { not: 'hermes' } },
    orderBy: { createdAt: 'desc' },
    include: { deployment: true, _count: { select: { agentLinks: true, snapshots: true } } },
  });
}

export async function listManagedAgentRuntimes(workspaceId: string) {
  return db.agentRuntime.findMany({
    where: { workspaceId, kind: 'hermes' },
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
          deploymentId: true,
          deployment: { select: { status: true } },
        },
      },
    },
  });
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
