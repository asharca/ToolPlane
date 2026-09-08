import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { effectiveStatuses } from '@/lib/process/supervisor';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';
import { writeAudit } from '@/lib/observability/audit';

const PAGE_SIZE = 25;

export async function listWorkspaces({ page = 1, q = '', owner = '', status }: { page?: number; q?: string; owner?: string; status?: string }) {
  const currentPage = normalizeAdminPage(page);
  const where: Prisma.WorkspaceWhereInput = {
    ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] } : {}),
    ...(owner ? { owner: { OR: [{ id: owner }, { email: { contains: owner, mode: 'insensitive' } }, { name: { contains: owner, mode: 'insensitive' } }] } } : {}),
    ...(['active', 'deleting', 'delete_failed'].includes(status ?? '') ? { status } : {}),
  };
  const skip = (currentPage - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.workspace.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: PAGE_SIZE,
      select: {
        id: true, slug: true, name: true, status: true, createdAt: true,
        owner: { select: { id: true, email: true } },
        _count: { select: { members: true, deployments: true, agents: true } },
      },
    }),
    db.workspace.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export async function getWorkspaceDetail(id: string) {
  const workspace = await db.workspace.findUnique({
    where: { id },
    select: {
      id: true, slug: true, name: true, status: true, createdAt: true,
      owner: { select: { id: true, email: true } },
      members: { select: { role: true, user: { select: { id: true, email: true } } } },
      deployments: { select: { id: true, name: true, source: true, status: true } },
      agents: { select: { id: true, name: true, runtimeKind: true, model: true }, orderBy: { name: 'asc' } },
      sandboxes: { select: { id: true, name: true, kind: true, deploymentId: true }, orderBy: { name: 'asc' } },
      _count: { select: { toolkits: true, installedSkills: true, modelProviders: true } },
    },
  });
  if (!workspace) return null;

  const statuses = effectiveStatuses(workspace.deployments);
  const recentErrors = await db.logEvent.findMany({
    where: { workspaceId: id, outcome: { in: ['error', 'timeout'] }, createdAt: { gte: new Date(Date.now() - 86400_000) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8,
    select: { id: true, message: true, eventName: true, createdAt: true, outcome: true },
  });
  return {
    ...workspace,
    recentErrors,
    sandboxes: workspace.sandboxes.map((sandbox) => ({ ...sandbox, status: statuses.get(sandbox.deploymentId) ?? 'stopped' })),
    deployments: workspace.deployments.map((deployment) => ({
      ...deployment,
      status: statuses.get(deployment.id) ?? deployment.status,
    })),
  };
}

export async function deleteManagedWorkspace(workspaceId: string, actorId = 'system') {
  await writeAudit(db, { actorId, workspaceId, action: 'workspace.delete.requested', targetType: 'workspace', targetId: workspaceId });
  try {
    await killWorkspaceProcesses(workspaceId);
    await db.$transaction(async (tx) => {
      await tx.workspace.delete({ where: { id: workspaceId } });
      await writeAudit(tx, { actorId, workspaceId, action: 'workspace.deleted', targetType: 'workspace', targetId: workspaceId });
    });
  } catch (error) {
    await writeAudit(db, { actorId, workspaceId, action: 'workspace.delete.failed', targetType: 'workspace', targetId: workspaceId, outcome: 'error' });
    throw error;
  }
}
