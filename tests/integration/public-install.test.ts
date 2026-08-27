// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { upsertInstalledSkill } from '@/lib/skills/install';

const stamp = Date.now();
let wsId = '';
let skillId = '';

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `pi-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({ data: { slug: `pi-${stamp}`, name: 'PI', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } } });
  wsId = ws.id;
  const sk = await db.skill.create({ data: { slug: `pi-skill-${stamp}`, name: 'PI Skill' } });
  skillId = sk.id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: `pi-${stamp}@t.dev` } });
  await db.skill.deleteMany({ where: { id: skillId } });
});

describe('upsertInstalledSkill', () => {
  it('installs and is idempotent', async () => {
    const a = await upsertInstalledSkill(wsId, skillId);
    const b = await upsertInstalledSkill(wsId, skillId);
    expect(a.id).toBe(b.id);
    expect(await db.installedSkill.count({ where: { workspaceId: wsId, skillId } })).toBe(1);
  });
});
