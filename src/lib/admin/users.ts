import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';
import { writeAudit } from '@/lib/observability/audit';

const PAGE_SIZE = 25;

export async function listUsers({ page = 1, q = '', role, status }: { page?: number; q?: string; role?: string; status?: string }) {
  const currentPage = normalizeAdminPage(page);
  const where: Prisma.UserWhereInput = {
    ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
    ...(role === 'admin' || role === 'user' ? { role } : {}),
    ...(status === 'active' || status === 'suspended' ? { status } : {}),
  };
  const skip = (currentPage - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: PAGE_SIZE,
      select: {
        id: true, email: true, name: true, role: true, status: true, createdAt: true,
        _count: { select: { ownedWorkspaces: true, memberships: true, apiTokens: true } },
      },
    }),
    db.user.count({ where }),
  ]);
  return { items, total, page: currentPage, pageSize: PAGE_SIZE };
}

export async function getUserDetail(id: string) {
  return db.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, role: true, status: true, createdAt: true,
      _count: { select: { apiTokens: true } },
      ownedWorkspaces: { select: { id: true, slug: true, name: true, _count: { select: { deployments: true, agents: true, sandboxes: true } } } },
      memberships: { select: { role: true, workspace: { select: { id: true, slug: true, name: true } } } },
    },
  });
}

function refuseSelf(actingUserId: string, userId: string) {
  if (actingUserId === userId) throw new Error("You can't change yourself.");
}

export async function setUserRole(actingUserId: string, userId: string, role: 'user' | 'admin') {
  refuseSelf(actingUserId, userId);
  await db.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });
    await tx.user.update({ where: { id: userId }, data: { role } });
    await writeAudit(tx, { actorId: actingUserId, action: 'user.role.changed', targetType: 'user', targetId: userId, changes: { before, after: { role } } });
  });
}

export async function setUserStatus(actingUserId: string, userId: string, status: 'active' | 'suspended') {
  refuseSelf(actingUserId, userId);
  await db.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } });
    await tx.user.update({ where: { id: userId }, data: { status } });
    await writeAudit(tx, { actorId: actingUserId, action: 'user.status.changed', targetType: 'user', targetId: userId, changes: { before, after: { status } } });
  });
}

export async function deleteManagedUser(actingUserId: string, userId: string) {
  refuseSelf(actingUserId, userId);
  const workspaces = await db.workspace.findMany({ where: { ownerId: userId }, select: { id: true } });
  await writeAudit(db, { actorId: actingUserId, action: 'user.delete.requested', targetType: 'user', targetId: userId });
  try {
    for (const ws of workspaces) await killWorkspaceProcesses(ws.id);
    await db.$transaction(async (tx) => {
      await tx.user.delete({ where: { id: userId } });
      await writeAudit(tx, { actorId: actingUserId, action: 'user.deleted', targetType: 'user', targetId: userId });
    });
  } catch (error) {
    await writeAudit(db, { actorId: actingUserId, action: 'user.delete.failed', targetType: 'user', targetId: userId, outcome: 'error' });
    throw error;
  }
}
