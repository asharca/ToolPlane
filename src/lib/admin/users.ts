import 'server-only';
import { db } from '@/lib/db';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

const PAGE_SIZE = 25;

export async function listUsers({ page = 1, q = '' }: { page?: number; q?: string }) {
  const where = q
    ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] }
    : {};
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      select: {
        id: true, email: true, name: true, role: true, status: true, createdAt: true,
        _count: { select: { ownedWorkspaces: true, memberships: true, apiTokens: true } },
      },
    }),
    db.user.count({ where }),
  ]);
  return { items, total, page: Math.max(1, page), pageSize: PAGE_SIZE };
}

export async function getUserDetail(id: string) {
  return db.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, role: true, status: true, createdAt: true,
      ownedWorkspaces: { select: { id: true, slug: true, name: true } },
      memberships: { select: { role: true, workspace: { select: { id: true, slug: true, name: true } } } },
    },
  });
}

function refuseSelf(actingUserId: string, userId: string) {
  if (actingUserId === userId) throw new Error("You can't change yourself.");
}

export async function setUserRole(actingUserId: string, userId: string, role: 'user' | 'admin') {
  refuseSelf(actingUserId, userId);
  await db.user.update({ where: { id: userId }, data: { role } });
}

export async function setUserStatus(actingUserId: string, userId: string, status: 'active' | 'suspended') {
  refuseSelf(actingUserId, userId);
  await db.user.update({ where: { id: userId }, data: { status } });
}

export async function deleteManagedUser(actingUserId: string, userId: string) {
  refuseSelf(actingUserId, userId);
  const workspaces = await db.workspace.findMany({ where: { ownerId: userId }, select: { id: true } });
  for (const ws of workspaces) await killWorkspaceProcesses(ws.id);
  await db.user.delete({ where: { id: userId } });
}
