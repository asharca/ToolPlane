// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { POST as skillInvocation } from '@/app/api/v1/plugin/skill-invocation/route';
import { POST as syncApplied } from '@/app/api/v1/plugin/sync-applied/route';
import { POST as syncFailure } from '@/app/api/v1/plugin/sync-failure/route';

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
    data: { email: `tel-${stamp}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  wsSlug = `tel-${stamp}`;
  const ws = await db.workspace.create({
    data: {
      slug: wsSlug,
      name: 'Tel',
      ownerId: userId,
      members: { create: { userId, role: 'owner' } },
    },
  });
  workspaceId = ws.id;
  tkSlug = `kit-${stamp}`;
  await db.toolkit.create({ data: { workspaceId, slug: tkSlug, name: 'Kit' } });
  ({ token } = await createApiToken(userId, 'tel'));

  const other = await db.user.create({
    data: { email: `tel-other-${stamp}@test.dev`, passwordHash: 'x' },
  });
  otherUserId = other.id;
  const otherWs = await db.workspace.create({
    data: {
      slug: `tel-other-${stamp}`,
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

function post(
  handler: (req: Request) => Promise<Response>,
  body: unknown,
  authToken: string | null,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return handler(
    new Request('http://localhost/api/v1/plugin/x', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

const invocationBody = (over: Record<string, unknown> = {}) => ({
  workspaceSlug: wsSlug,
  toolkitSlug: tkSlug,
  skillSlug: 'alpha-skill',
  source: 'user',
  outcome: 'success',
  ...over,
});

describe('POST /api/v1/plugin/skill-invocation', () => {
  it('records an invocation for a member token', async () => {
    const res = await post(skillInvocation, invocationBody(), token);
    expect(res.status).toBe(200);
    const row = await db.skillInvocation.findFirst({
      where: { workspaceId, skillSlug: 'alpha-skill' },
    });
    expect(row?.source).toBe('user');
    expect(row?.outcome).toBe('success');
  });

  it('records an error outcome with its errorClass', async () => {
    const res = await post(
      skillInvocation,
      invocationBody({ skillSlug: 'beta-skill', source: 'agent', outcome: 'error', errorClass: 'timeout' }),
      token,
    );
    expect(res.status).toBe(200);
    const row = await db.skillInvocation.findFirst({
      where: { workspaceId, skillSlug: 'beta-skill' },
    });
    expect(row?.errorClass).toBe('timeout');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await post(skillInvocation, invocationBody(), null);
    expect(res.status).toBe(401);
  });

  it('does not record against another workspace toolkit (404, no row)', async () => {
    const res = await post(skillInvocation, invocationBody({ skillSlug: 'leak-skill' }), otherToken);
    expect(res.status).toBe(404);
    const row = await db.skillInvocation.findFirst({
      where: { skillSlug: 'leak-skill' },
    });
    expect(row).toBeNull();
  });

  it('rejects an invalid body (bad enum)', async () => {
    const res = await post(skillInvocation, invocationBody({ source: 'robot' }), token);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/plugin/sync-applied', () => {
  it('records a sync delta', async () => {
    const res = await post(
      syncApplied,
      { workspaceSlug: wsSlug, toolkitSlug: tkSlug, added: 2, removed: 1, updated: 3, total: 5 },
      token,
    );
    expect(res.status).toBe(200);
    const row = await db.syncEvent.findFirst({
      where: { workspaceId, outcome: 'applied' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.added).toBe(2);
    expect(row?.total).toBe(5);
  });

  it('rejects a negative count', async () => {
    const res = await post(
      syncApplied,
      { workspaceSlug: wsSlug, toolkitSlug: tkSlug, added: -1, removed: 0, updated: 0, total: 0 },
      token,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/plugin/sync-failure', () => {
  it('records a sync failure reason', async () => {
    const res = await post(
      syncFailure,
      { workspaceSlug: wsSlug, toolkitSlug: tkSlug, reason: 'fetch_failed' },
      token,
    );
    expect(res.status).toBe(200);
    const row = await db.syncEvent.findFirst({
      where: { workspaceId, outcome: 'failure' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.reason).toBe('fetch_failed');
  });
});
