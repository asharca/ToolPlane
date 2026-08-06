// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route handlers are invoked directly in this integration test rather than
// through Next's request runtime, so provide the empty cookie store that an
// unauthenticated browser request would expose.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { GET } from '@/app/api/v1/mcp/[deploymentId]/runtime/route';

let ownerId = '';
let workspaceId = '';
let deploymentId = '';
let ownerToken = '';
let memberId = '';
let memberToken = '';
let outsiderId = '';
let outsiderToken = '';

const stamp = Date.now();

beforeAll(async () => {
  const owner = await db.user.create({
    data: { email: `runtime-owner-${stamp}@test.dev`, passwordHash: 'x' },
  });
  ownerId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `runtime-${stamp}`,
      name: 'Runtime route',
      ownerId,
      members: { create: { userId: ownerId, role: 'owner' } },
    },
  });
  workspaceId = workspace.id;
  const deployment = await db.deployment.create({
    data: { workspaceId, name: 'Runtime MCP', status: 'provisioning' },
  });
  deploymentId = deployment.id;
  ({ token: ownerToken } = await createApiToken(ownerId, 'runtime owner'));

  const member = await db.user.create({
    data: { email: `runtime-member-${stamp}@test.dev`, passwordHash: 'x' },
  });
  memberId = member.id;
  await db.membership.create({
    data: { workspaceId, userId: memberId, role: 'member' },
  });
  ({ token: memberToken } = await createApiToken(memberId, 'runtime member'));

  const outsider = await db.user.create({
    data: { email: `runtime-outsider-${stamp}@test.dev`, passwordHash: 'x' },
  });
  outsiderId = outsider.id;
  ({ token: outsiderToken } = await createApiToken(outsiderId, 'runtime outsider'));
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: ownerId } });
  await db.user.delete({ where: { id: memberId } });
  await db.user.delete({ where: { id: outsiderId } });
  await db.$disconnect();
});

describe('GET /api/v1/mcp/[deploymentId]/runtime', () => {
  it('returns an empty live runtime snapshot instead of requiring a live port', async () => {
    const res = await GET(
      new Request(`http://localhost/api/v1/mcp/${deploymentId}/runtime?cursor=0`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
      { params: Promise.resolve({ deploymentId }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      snapshot: null,
      logs: {
        generation: null,
        cursor: 0,
        nextCursor: expect.any(Number),
        text: expect.any(String),
      },
    });
    expect(typeof body.logs.reset).toBe('boolean');
  });

  it('requires an authenticated owner or workspace member', async () => {
    const unauthenticated = await GET(
      new Request(`http://localhost/api/v1/mcp/${deploymentId}/runtime`),
      { params: Promise.resolve({ deploymentId }) },
    );
    expect(unauthenticated.status).toBe(401);

    const outsider = await GET(
      new Request(`http://localhost/api/v1/mcp/${deploymentId}/runtime`, {
        headers: { authorization: `Bearer ${outsiderToken}` },
      }),
      { params: Promise.resolve({ deploymentId }) },
    );
    expect(outsider.status).toBe(404);

    const member = await GET(
      new Request(`http://localhost/api/v1/mcp/${deploymentId}/runtime`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      { params: Promise.resolve({ deploymentId }) },
    );
    expect(member.status).toBe(200);
  });
});
