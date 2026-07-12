// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  addServersToToolkitAction,
  addSkillsToToolkitAction,
} from '@/lib/toolkits/actions';

const stamp = Date.now();
const ownerEmail = `toolkit-batch-owner-${stamp}@test.dev`;
const foreignEmail = `toolkit-batch-foreign-${stamp}@test.dev`;
const ownerSlug = `toolkit-batch-owner-${stamp}`;
const foreignSlug = `toolkit-batch-foreign-${stamp}`;
const toolkitSlug = 'batch-kit';

let ownerId = '';
let toolkitId = '';
let deploymentIds: string[] = [];
let sandboxDeploymentId = '';
let foreignDeploymentId = '';
let skillIds: string[] = [];
let foreignSkillId = '';

function batchForm(ids: string[], targetToolkit = toolkitSlug): FormData {
  const form = new FormData();
  form.set('workspace', ownerSlug);
  form.set('toolkitSlug', targetToolkit);
  ids.forEach((id) => form.append('resourceId', id));
  return form;
}

describe('toolkit batch add actions', () => {
  beforeAll(async () => {
    const [owner, foreign] = await Promise.all([
      db.user.create({ data: { email: ownerEmail, passwordHash: 'x' } }),
      db.user.create({ data: { email: foreignEmail, passwordHash: 'x' } }),
    ]);
    ownerId = owner.id;
    const [ownerWorkspace, foreignWorkspace] = await Promise.all([
      db.workspace.create({
        data: {
          slug: ownerSlug,
          name: 'Batch Owner',
          ownerId: owner.id,
          members: { create: { userId: owner.id, role: 'owner' } },
        },
      }),
      db.workspace.create({
        data: {
          slug: foreignSlug,
          name: 'Batch Foreign',
          ownerId: foreign.id,
          members: { create: { userId: foreign.id, role: 'owner' } },
        },
      }),
    ]);
    const [toolkit] = await Promise.all([
      db.toolkit.create({ data: { workspaceId: ownerWorkspace.id, slug: toolkitSlug, name: 'Batch Kit' } }),
      db.toolkit.create({ data: { workspaceId: foreignWorkspace.id, slug: 'foreign-kit', name: 'Foreign Kit' } }),
    ]);
    toolkitId = toolkit.id;

    const deployments = await Promise.all([
      db.deployment.create({ data: { workspaceId: ownerWorkspace.id, name: 'MCP One', source: 'npm', sourceRef: 'one', status: 'stopped' } }),
      db.deployment.create({ data: { workspaceId: ownerWorkspace.id, name: 'MCP Two', source: 'github', sourceRef: 'two', status: 'stopped' } }),
      db.deployment.create({ data: { workspaceId: ownerWorkspace.id, name: 'MCP Three', source: 'docker', sourceRef: 'three', status: 'stopped' } }),
    ]);
    deploymentIds = deployments.map(({ id }) => id);
    sandboxDeploymentId = (
      await db.deployment.create({
        data: { workspaceId: ownerWorkspace.id, name: 'Sandbox MCP', source: 'sandbox', sourceRef: 'sandbox', status: 'stopped' },
      })
    ).id;
    foreignDeploymentId = (
      await db.deployment.create({
        data: { workspaceId: foreignWorkspace.id, name: 'Foreign MCP', source: 'npm', sourceRef: 'foreign', status: 'stopped' },
      })
    ).id;

    const skills = await Promise.all([
      db.installedSkill.create({ data: { workspaceId: ownerWorkspace.id, name: 'Skill One', slug: 'skill-one', source: 'custom' } }),
      db.installedSkill.create({ data: { workspaceId: ownerWorkspace.id, name: 'Skill Two', slug: 'skill-two', source: 'github' } }),
      db.installedSkill.create({ data: { workspaceId: ownerWorkspace.id, name: 'Skill Three', slug: 'skill-three', source: 'upload' } }),
    ]);
    skillIds = skills.map(({ id }) => id);
    foreignSkillId = (
      await db.installedSkill.create({
        data: { workspaceId: foreignWorkspace.id, name: 'Foreign Skill', slug: 'foreign-skill', source: 'custom' },
      })
    ).id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: ownerId, email: ownerEmail });
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { slug: { in: [ownerSlug, foreignSlug] } } });
    await db.user.deleteMany({ where: { email: { in: [ownerEmail, foreignEmail] } } });
    await db.$disconnect();
  });

  it('adds multiple MCPs and makes repeated submissions idempotent', async () => {
    await expect(addServersToToolkitAction({}, batchForm(deploymentIds.slice(0, 2)))).resolves.toEqual({ added: 2 });
    await expect(addServersToToolkitAction({}, batchForm(deploymentIds.slice(0, 2)))).resolves.toEqual({ added: 0 });
    expect(await db.toolkitServer.count({ where: { toolkitId } })).toBe(2);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/app/${ownerSlug}/toolkits/${toolkitSlug}`);
  });

  it('rejects a mixed-workspace MCP selection without partially adding it', async () => {
    await expect(
      addServersToToolkitAction({}, batchForm([deploymentIds[2], foreignDeploymentId])),
    ).resolves.toEqual({ error: 'One or more selected MCPs are unavailable.' });
    expect(
      await db.toolkitServer.findUnique({
        where: { toolkitId_deploymentId: { toolkitId, deploymentId: deploymentIds[2] } },
      }),
    ).toBeNull();
  });

  it('rejects sandbox deployments', async () => {
    await expect(addServersToToolkitAction({}, batchForm([sandboxDeploymentId]))).resolves.toEqual({
      error: 'One or more selected MCPs are unavailable.',
    });
  });

  it('adds multiple skills and rejects a mixed-workspace selection atomically', async () => {
    await expect(addSkillsToToolkitAction({}, batchForm(skillIds.slice(0, 2)))).resolves.toEqual({ added: 2 });
    await expect(addSkillsToToolkitAction({}, batchForm([skillIds[2], foreignSkillId]))).resolves.toEqual({
      error: 'One or more selected skills are unavailable.',
    });
    expect(
      await db.toolkitSkill.findUnique({
        where: { toolkitId_installedSkillId: { toolkitId, installedSkillId: skillIds[2] } },
      }),
    ).toBeNull();
  });

  it('rejects empty and oversized selections before writing', async () => {
    await expect(addSkillsToToolkitAction({}, batchForm([]))).resolves.toEqual({
      error: 'Select at least one item.',
    });
    await expect(addSkillsToToolkitAction({}, batchForm(Array.from({ length: 201 }, () => skillIds[0])))).resolves.toEqual({
      error: 'Select no more than 200 items at once.',
    });
    expect(await db.toolkitSkill.count({ where: { toolkitId } })).toBe(2);
  });

  it('cannot target a toolkit outside the selected workspace', async () => {
    await expect(addSkillsToToolkitAction({}, batchForm([skillIds[2]], 'foreign-kit'))).resolves.toEqual({
      error: 'Toolkit not found.',
    });
  });
});
