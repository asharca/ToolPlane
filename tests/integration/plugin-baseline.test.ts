// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { GET } from '@/app/api/v1/plugin/baseline/route';

let userId = '';
let otherUserId = '';
let workspaceId = '';
let otherWorkspaceId = '';
let wsSlug = '';
let tkSlug = '';
let token = '';
let otherToken = '';

const stamp = Date.now();

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `baseline-${stamp}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  wsSlug = `baseline-${stamp}`;
  const ws = await db.workspace.create({
    data: {
      slug: wsSlug,
      name: 'Baseline',
      ownerId: userId,
      members: { create: { userId, role: 'owner' } },
    },
  });
  workspaceId = ws.id;

  tkSlug = `kit-${stamp}`;
  const toolkit = await db.toolkit.create({
    data: { workspaceId, slug: tkSlug, name: 'Kit' },
  });

  const published = await db.installedSkill.create({
    data: {
      workspaceId,
      name: 'Alpha Skill',
      slug: 'alpha-skill',
      description: 'does alpha',
      content: '# Alpha\n\nbody',
      source: 'custom',
      status: 'published',
    },
  });
  const draft = await db.installedSkill.create({
    data: {
      workspaceId,
      name: 'Draft Skill',
      slug: 'draft-skill',
      content: '# Draft',
      source: 'custom',
      status: 'draft',
    },
  });
  await db.toolkitSkill.create({
    data: { toolkitId: toolkit.id, installedSkillId: published.id },
  });
  await db.toolkitSkill.create({
    data: { toolkitId: toolkit.id, installedSkillId: draft.id },
  });

  ({ token } = await createApiToken(userId, 'baseline'));

  // A second user/workspace with no access to the first toolkit.
  const other = await db.user.create({
    data: { email: `baseline-other-${stamp}@test.dev`, passwordHash: 'x' },
  });
  otherUserId = other.id;
  const otherWs = await db.workspace.create({
    data: {
      slug: `baseline-other-${stamp}`,
      name: 'Other',
      ownerId: otherUserId,
      members: { create: { userId: otherUserId, role: 'owner' } },
    },
  });
  otherWorkspaceId = otherWs.id;
  ({ token: otherToken } = await createApiToken(otherUserId, 'other'));
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.workspace.delete({ where: { id: otherWorkspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.user.delete({ where: { id: otherUserId } });
  await db.$disconnect();
});

function call(authToken: string | null, ws = wsSlug, tk = tkSlug) {
  const url = `http://localhost/api/v1/plugin/baseline?workspace=${ws}&toolkit=${tk}`;
  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return GET(new Request(url, { headers }));
}

describe('GET /api/v1/plugin/baseline', () => {
  it('returns published toolkit skills with slug/version/content and excludes drafts', async () => {
    const res = await call(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { skills: { slug: string; version: string; content: string }[] };
    };
    const slugs = body.data.skills.map((s) => s.slug);
    expect(slugs).toContain('alpha-skill');
    expect(slugs).not.toContain('draft-skill');

    const alpha = body.data.skills.find((s) => s.slug === 'alpha-skill')!;
    expect(alpha.content).toContain('name: alpha-skill');
    expect(alpha.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
  });

  it('does not leak another workspace toolkit to a non-member token', async () => {
    const res = await call(otherToken);
    expect(res.status).toBe(404);
  });
});
