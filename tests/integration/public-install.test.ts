// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
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

describe('upsertInstalledSkill', () => {
  it('installs and is idempotent', async () => {
    const a = await upsertInstalledSkill(wsId, skillId);
    const b = await upsertInstalledSkill(wsId, skillId);
    expect(a.id).toBe(b.id);
    expect(await db.installedSkill.count({ where: { workspaceId: wsId, skillId } })).toBe(1);
  });
});
