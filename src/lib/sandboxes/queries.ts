import 'server-only';
import { db } from '@/lib/db';

export async function listSandboxes(workspaceId: string) {
  return db.sandbox.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { deployment: true, _count: { select: { agentLinks: true } } },
  });
}

export async function getSandbox(workspaceId: string, sandboxId: string) {
  return db.sandbox.findFirst({
    where: { id: sandboxId, workspaceId },
    include: { deployment: true, agentLinks: { include: { agent: { select: { id: true, name: true } } } } },
  });
}
