import 'server-only';
import { db } from '@/lib/db';
import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

const PAGE_SIZE = 25;

export async function listWorkspaces({ page = 1, q = '' }: { page?: number; q?: string }) {
  const where = q
    ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q, mode: 'insensitive' as const } }] }
    : {};
  const skip = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [items, total] = await Promise.all([
    db.workspace.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      select: {
        id: true, slug: true, name: true, createdAt: true,
        owner: { select: { id: true, email: true } },
        _count: { select: { members: true, deployments: true, agents: true } },
      },
    }),
    db.workspace.count({ where }),
  ]);
  return { items, total, page: Math.max(1, page), pageSize: PAGE_SIZE };
}

export async function getWorkspaceDetail(id: string) {
  return db.workspace.findUnique({
    where: { id },
    select: {
      id: true, slug: true, name: true, createdAt: true,
      owner: { select: { id: true, email: true } },
      members: { select: { role: true, user: { select: { id: true, email: true } } } },
      deployments: { select: { id: true, name: true, source: true, status: true } },
    },
  });
}

export async function deleteManagedWorkspace(workspaceId: string) {
  await killWorkspaceProcesses(workspaceId);
  await db.workspace.delete({ where: { id: workspaceId } });
}
