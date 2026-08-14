// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { getDeploymentLogs, getObservability } from '@/lib/observability/log';

const stamp = Date.now();
let userId = '';
let workspaceId = '';
let deploymentId = '';
let foreignUserId = '';
let foreignWorkspaceId = '';

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
        deploymentId,
        method: 'POST',
        path: `/mcp/${deploymentId}/rpc#tools/call:semantic_failure`,
        statusCode: 200,
        durationMs: 31,
        requestBody: JSON.stringify({ id: 'semantic-failure' }),
        responseBody: JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: 'tool failed' }] } }),
        createdAt: new Date(now - 56 * 10 * 60 * 1000),
      },
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

  const foreignUser = await db.user.create({
    data: { email: `observability-foreign-${stamp}@test.dev`, passwordHash: 'x' },
  });
  foreignUserId = foreignUser.id;
  const foreignWorkspace = await db.workspace.create({
    data: {
      slug: `observability-foreign-${stamp}`,
      name: 'Foreign observability workspace',
      ownerId: foreignUserId,
      members: { create: { userId: foreignUserId, role: 'owner' } },
    },
  });
  foreignWorkspaceId = foreignWorkspace.id;
  // Deployment IDs are not foreign-keyed on RequestLog. This row verifies the
  // reader cannot leak a malformed/cross-workspace record by deployment ID.
  await db.requestLog.create({
    data: {
      workspaceId: foreignWorkspaceId,
      deploymentId,
      method: 'POST',
      path: '/foreign/rpc#tools/call:should_not_leak',
      statusCode: 200,
      durationMs: 1,
    },
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: foreignWorkspaceId } });
  await db.user.delete({ where: { id: foreignUserId } });
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('getObservability', () => {
  it('returns bounded recent details, hourly buckets, and deployment rollups', async () => {
    const result = await getObservability(workspaceId, 'Asia/Shanghai');

    expect(result.total).toBe(57);
    expect(result.errors).toBe(7);
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
      total: 56,
      errors: 7,
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
    expect(result.total).toBe(56);
    expect(result.deploymentUsage).toHaveLength(1);
    expect(result.deploymentUsage[0]?.id).toBe(deploymentId);
  });

  it('keeps deployment request logs within the requested workspace', async () => {
    const logs = await getDeploymentLogs(workspaceId, deploymentId);

    expect(logs).toHaveLength(56);
    expect(logs.some((log) => log.path.includes('should_not_leak'))).toBe(false);
  });
});
