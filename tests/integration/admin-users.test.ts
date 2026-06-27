// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { listUsers, setUserRole, setUserStatus, deleteManagedUser } from '@/lib/admin/users';

const stamp = Date.now();
let adminId = '';
let targetId = '';

beforeAll(async () => {
  const admin = await db.user.create({ data: { email: `au-admin-${stamp}@t.dev`, passwordHash: 'x', role: 'admin' } });
  const target = await db.user.create({ data: { email: `au-tgt-${stamp}@t.dev`, passwordHash: 'x' } });
  adminId = admin.id;
  targetId = target.id;
});

describe('admin user mutations', () => {
  it('promotes and demotes a user', async () => {
    await setUserRole(adminId, targetId, 'admin');
    expect((await db.user.findUnique({ where: { id: targetId } }))?.role).toBe('admin');
    await setUserRole(adminId, targetId, 'user');
    expect((await db.user.findUnique({ where: { id: targetId } }))?.role).toBe('user');
  });

  it('suspends and reactivates a user', async () => {
    await setUserStatus(adminId, targetId, 'suspended');
    expect((await db.user.findUnique({ where: { id: targetId } }))?.status).toBe('suspended');
    await setUserStatus(adminId, targetId, 'active');
  });

  it('refuses to act on self', async () => {
    await expect(setUserRole(adminId, adminId, 'user')).rejects.toThrow(/yourself/i);
    await expect(setUserStatus(adminId, adminId, 'suspended')).rejects.toThrow(/yourself/i);
    await expect(deleteManagedUser(adminId, adminId)).rejects.toThrow(/yourself/i);
  });

  it('lists users with counts and search', async () => {
    const res = await listUsers({ page: 1, q: `au-tgt-${stamp}` });
    expect(res.items.some((u) => u.id === targetId)).toBe(true);
    expect(res.items[0]).toHaveProperty('_count');
  });

  it('deletes a managed user', async () => {
    const victim = await db.user.create({ data: { email: `au-del-${stamp}@t.dev`, passwordHash: 'x' } });
    await deleteManagedUser(adminId, victim.id);
    expect(await db.user.findUnique({ where: { id: victim.id } })).toBeNull();
  });
});
