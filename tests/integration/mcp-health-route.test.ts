// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken } from '@/lib/auth/tokens';
import { GET } from '@/app/api/v1/mcp/[deploymentId]/health/route';

let userId = '';
let workspaceId = '';
let deploymentId = '';
let token = '';

const stamp = Date.now();

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `health-${stamp}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `health-${stamp}`,
      name: 'Health',
      ownerId: userId,
      members: { create: { userId, role: 'owner' } },
    },
  });
  workspaceId = workspace.id;
  const deployment = await db.deployment.create({
    data: { workspaceId, name: 'Health MCP', status: 'running' },
  });
  deploymentId = deployment.id;
  ({ token } = await createApiToken(userId, 'health'));
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('GET /api/v1/mcp/[deploymentId]/health', () => {
  it('accepts Bearer API tokens, not only browser cookies', async () => {
    const res = await GET(
      new Request(`http://localhost/api/v1/mcp/${deploymentId}/health`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ deploymentId }) },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: 'stopped', reachable: false });
  });
});
