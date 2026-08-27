// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { setAgentTools } from '@/lib/agents/mutations';

let userId = '';
let otherUserId = '';
let workspaceId = '';
let otherWorkspaceId = '';
let parentId = '';
let childId = '';
let crossId = '';
let parentSandboxId = '';

const stamp = Date.now();
const noTools = { deploymentIds: [], installedSkillIds: [], toolkitIds: [] };

beforeAll(async () => {
  const user = await db.user.create({ data: { email: `sa-${stamp}@test.dev`, passwordHash: 'x' } });
  userId = user.id;
  const ws = await db.workspace.create({
    data: {
      slug: `sa-${stamp}`,
      name: 'SA',
      ownerId: userId,
      members: { create: { userId, role: 'owner' } },
    },
  });
  workspaceId = ws.id;

  const other = await db.user.create({ data: { email: `sa-other-${stamp}@test.dev`, passwordHash: 'x' } });
  otherUserId = other.id;
  const otherWs = await db.workspace.create({
    data: {
      slug: `sa-other-${stamp}`,
      name: 'Other',
      ownerId: otherUserId,
      members: { create: { userId: otherUserId, role: 'owner' } },
    },
  });
  otherWorkspaceId = otherWs.id;

  const sandboxDeployment = await db.deployment.create({
    data: { workspaceId, name: 'Parent sandbox', source: 'sandbox', status: 'stopped' },
  });
  parentSandboxId = (await db.sandbox.create({
    data: {
      workspaceId,
      deploymentId: sandboxDeployment.id,
      name: 'Parent sandbox',
      slug: `parent-sandbox-${stamp}`,
      kind: 'docker',
      network: 'isolated',
    },
  })).id;

  const parent = await db.agent.create({ data: { workspaceId, name: 'Parent', slug: 'parent', runtimeKind: 'pi' } });
  const child = await db.agent.create({ data: { workspaceId, name: 'Child', slug: 'child', runtimeKind: 'pi' } });
  const cross = await db.agent.create({ data: { workspaceId: otherWorkspaceId, name: 'Cross', slug: 'cross', runtimeKind: 'pi' } });
  parentId = parent.id;
  childId = child.id;
  crossId = cross.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.workspace.delete({ where: { id: otherWorkspaceId } });
  await db.user.delete({ where: { id: userId } });
  await db.user.delete({ where: { id: otherUserId } });
  await db.$disconnect();
});

describe('setAgentTools sub-agents', () => {
  it('persists same-workspace links and drops self + cross-workspace', async () => {
    await setAgentTools(workspaceId, parentId, {
      ...noTools,
      sandboxIds: [parentSandboxId],
      subAgentIds: [childId, parentId, crossId],
    });
    const links = await db.agentSubAgent.findMany({ where: { parentId } });
    expect(links.map((l) => l.childId)).toEqual([childId]);
  });

  it('replaces links on re-save (empty clears)', async () => {
    await setAgentTools(workspaceId, parentId, {
      ...noTools,
      sandboxIds: [parentSandboxId],
      subAgentIds: [],
    });
    const links = await db.agentSubAgent.findMany({ where: { parentId } });
    expect(links).toHaveLength(0);
  });
});
