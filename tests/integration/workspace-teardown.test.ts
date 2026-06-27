// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { workspaceDeploymentIds } from '@/lib/workspace/teardown';

const stamp = Date.now();
let wsId = '';
let depId = '';

beforeAll(async () => {
  const u = await db.user.create({ data: { email: `td-${stamp}@t.dev`, passwordHash: 'x' } });
  const ws = await db.workspace.create({
    data: { slug: `td-${stamp}`, name: 'TD', ownerId: u.id, members: { create: { userId: u.id, role: 'owner' } } },
  });
  wsId = ws.id;
  const dep = await db.deployment.create({ data: { workspaceId: ws.id, source: 'npm', sourceRef: 'x', status: 'stopped' } });
  depId = dep.id;
});

describe('workspaceDeploymentIds', () => {
  it('returns the ids of the workspace deployments', async () => {
    expect(await workspaceDeploymentIds(wsId)).toEqual([depId]);
  });
});
