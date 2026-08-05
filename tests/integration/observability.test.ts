// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getObservability } from '@/lib/observability/log';

const stamp = Date.now();
let userId = '';
let workspaceId = '';
let deploymentId = '';

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `observability-${stamp}@test.dev`, passwordHash: 'x' },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `observability-${stamp}`,
      name: 'Observability test workspace',
      ownerId: userId,
      members: { create: { userId, role: 'owner' } },
    },
  });
  workspaceId = workspace.id;
  const deployment = await db.deployment.create({
    data: { workspaceId, name: 'Seed MCP', source: 'config', status: 'running' },
  });
  deploymentId = deployment.id;

  const now = Date.now();
  await db.requestLog.createMany({
    data: [
      ...Array.from({ length: 55 }, (_, index) => ({
        workspaceId,
        deploymentId,
        method: 'POST',
        path: `/mcp/${deploymentId}/rpc#tools/call:echo`,
        statusCode: index % 10 === 0 ? 500 : 200,
        durationMs: 20 + index,
        requestBody: JSON.stringify({ id: index }),
        responseBody: JSON.stringify({ ok: index % 10 !== 0 }),
        createdAt: new Date(now - index * 10 * 60 * 1000),
      })),
      {
        workspaceId,
        method: 'GET',
        path: '/workspaces/test/manifest',
        statusCode: 200,
        durationMs: 12,
        responseBody: JSON.stringify({ ok: true }),
        createdAt: new Date(now - 60 * 60 * 1000),
      },
    ],
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('getObservability', () => {
  it('returns bounded recent details, hourly buckets, and deployment rollups', async () => {
    const result = await getObservability(workspaceId, 'Asia/Shanghai');

    expect(result.total).toBe(56);
    expect(result.errors).toBe(6);
    expect(result.series).toHaveLength(24);
    expect(result.recent).toHaveLength(50);
    expect(result.recent[0]).toMatchObject({
      deploymentId,
      deploymentName: 'Seed MCP',
      requestBody: expect.any(String),
      responseBody: expect.any(String),
    });
    expect(result.deploymentUsage).toContainEqual(expect.objectContaining({
      id: deploymentId,
      name: 'Seed MCP',
      total: 55,
      errors: 6,
    }));
    expect(result.deploymentUsage).toContainEqual(expect.objectContaining({
      id: null,
      name: 'Workspace API',
      total: 1,
    }));
  });

  it('scopes deployment filters to the workspace', async () => {
    const result = await getObservability(workspaceId, 'UTC', 24, deploymentId);

    expect(result.selectedDeployment).toBe('Seed MCP');
    expect(result.total).toBe(55);
    expect(result.deploymentUsage).toHaveLength(1);
    expect(result.deploymentUsage[0]?.id).toBe(deploymentId);
  });
});
