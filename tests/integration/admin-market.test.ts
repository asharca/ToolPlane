// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import {
  createDirectoryServer, updateDirectoryServer, deleteDirectoryServer,
  createDirectorySkill, deleteDirectorySkill,
} from '@/lib/admin/market';

const stamp = Date.now();

describe('directory server mutations', () => {
  it('creates a curated server', async () => {
    const s = await createDirectoryServer({ slug: `ms-${stamp}`, name: 'MS', author: null, description: null, iconUrl: null, stars: 5, isOfficial: false, isFeatured: true, categoryIds: [] });
    expect(s.curated).toBe(true);
    expect(s.isFeatured).toBe(true);
  });
  it('update keeps curated true', async () => {
    const s = await db.server.findUnique({ where: { slug: `ms-${stamp}` } });
    const upd = await updateDirectoryServer(s!.id, { name: 'MS2', author: null, description: null, iconUrl: null, stars: 9, isOfficial: true, isFeatured: false, categoryIds: [] });
    expect(upd.name).toBe('MS2');
    expect(upd.curated).toBe(true);
  });
  it('refuses to delete a server with deployments', async () => {
    const s = await db.server.create({ data: { slug: `msd-${stamp}`, name: 'MSD', curated: true } });
    const u = await db.user.create({ data: { email: `msd-${stamp}@t.dev`, passwordHash: 'x' } });
    const ws = await db.workspace.create({ data: { slug: `msd-${stamp}`, name: 'w', ownerId: u.id } });
    await db.deployment.create({ data: { workspaceId: ws.id, serverId: s.id, status: 'stopped' } });
    await expect(deleteDirectoryServer(s.id)).rejects.toThrow(/deployment/i);
  });
  it('deletes a server with no deployments', async () => {
    const s = await db.server.create({ data: { slug: `msok-${stamp}`, name: 'OK', curated: true } });
    await deleteDirectoryServer(s.id);
    expect(await db.server.findUnique({ where: { id: s.id } })).toBeNull();
  });
});

describe('directory skill mutations', () => {
  it('creates curated and refuses delete with installs', async () => {
    const sk = await createDirectorySkill({ slug: `mk-${stamp}`, name: 'MK', author: null, description: null, iconUrl: null, score: 3, categoryIds: [] });
    expect(sk.curated).toBe(true);
    const u = await db.user.create({ data: { email: `mk-${stamp}@t.dev`, passwordHash: 'x' } });
    const ws = await db.workspace.create({ data: { slug: `mk-${stamp}`, name: 'w', ownerId: u.id } });
    await db.installedSkill.create({ data: { workspaceId: ws.id, skillId: sk.id } });
    await expect(deleteDirectorySkill(sk.id)).rejects.toThrow(/install/i);
  });
});
