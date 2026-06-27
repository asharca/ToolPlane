// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { listWorkspaces, deleteManagedWorkspace } from '@/lib/admin/workspaces';

const stamp = Date.now();
let wsId = '';

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `aw-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({
    data: { slug: `aw-${stamp}`, name: 'AW', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } },
  });
  wsId = ws.id;
});

describe('admin workspaces', () => {
  it('lists workspaces with owner + counts', async () => {
    const res = await listWorkspaces({ page: 1, q: `aw-${stamp}` });
    const row = res.items.find((w) => w.id === wsId);
    expect(row?.owner.email).toBe(`aw-${stamp}@t.dev`);
    expect(row?._count.members).toBe(1);
  });
  it('deletes a workspace', async () => {
    await deleteManagedWorkspace(wsId);
    expect(await db.workspace.findUnique({ where: { id: wsId } })).toBeNull();
  });
});
