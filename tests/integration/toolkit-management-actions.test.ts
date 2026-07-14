// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { createApiToken, verifyApiToken } from '@/lib/auth/tokens';
import { issueInstallToken } from '@/lib/toolkits/install-link';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import {
  cloneToolkitAction,
  deleteToolkitAction,
  renameToolkitAction,
} from '@/lib/toolkits/actions';

const stamp = Date.now();
const ownerEmail = `toolkit-management-owner-${stamp}@test.dev`;
const foreignEmail = `toolkit-management-foreign-${stamp}@test.dev`;
const ownerSlug = `toolkit-management-owner-${stamp}`;
const foreignSlug = `toolkit-management-foreign-${stamp}`;

let ownerId = '';
let ownerWorkspaceId = '';
let foreignWorkspaceId = '';
let deploymentId = '';
let installedSkillId = '';
let agentId = '';

function actionForm(workspace: string, toolkitSlug: string, name?: string): FormData {
  const form = new FormData();
  form.set('workspace', workspace);
  form.set('toolkitSlug', toolkitSlug);
  if (name !== undefined) form.set('name', name);
  return form;
}

describe('toolkit management actions', () => {
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
          name: 'Toolkit Management Owner',
          ownerId: owner.id,
          members: { create: { userId: owner.id, role: 'owner' } },
        },
      }),
      db.workspace.create({
        data: {
          slug: foreignSlug,
          name: 'Toolkit Management Foreign',
          ownerId: foreign.id,
          members: { create: { userId: foreign.id, role: 'owner' } },
        },
      }),
    ]);
    ownerWorkspaceId = ownerWorkspace.id;
    foreignWorkspaceId = foreignWorkspace.id;

    const [deployment, installedSkill, agent] = await Promise.all([
      db.deployment.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Shared MCP',
          source: 'npm',
          sourceRef: '@example/shared-mcp',
          status: 'stopped',
        },
      }),
      db.installedSkill.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Shared Skill',
          slug: 'shared-skill',
          source: 'custom',
        },
      }),
      db.agent.create({
        data: {
          workspaceId: ownerWorkspace.id,
          name: 'Toolkit Consumer',
          slug: 'toolkit-consumer',
        },
      }),
    ]);
    deploymentId = deployment.id;
    installedSkillId = installedSkill.id;
    agentId = agent.id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: ownerId, email: ownerEmail });
  });

  afterEach(async () => {
    await db.toolkit.deleteMany({
      where: { workspaceId: { in: [ownerWorkspaceId, foreignWorkspaceId] } },
    });
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: { in: [ownerWorkspaceId, foreignWorkspaceId] } } });
    await db.user.deleteMany({ where: { email: { in: [ownerEmail, foreignEmail] } } });
    await db.$disconnect();
  });

  it('renames a toolkit after trimming the name and keeps its slug stable', async () => {
    const toolkit = await db.toolkit.create({
      data: { workspaceId: ownerWorkspaceId, name: 'Original Name', slug: 'stable-slug' },
    });

    await renameToolkitAction(actionForm(ownerSlug, toolkit.slug, '  Renamed Toolkit  '));

    await expect(db.toolkit.findUnique({ where: { id: toolkit.id } })).resolves.toMatchObject({
      name: 'Renamed Toolkit',
      slug: 'stable-slug',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/app/${ownerSlug}/toolkits`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/app/${ownerSlug}/toolkits/${toolkit.slug}`,
    );
  });

  it('clones the toolkit resource links without cloning its consumers or resources', async () => {
    const source = await db.toolkit.create({
      data: {
        workspaceId: ownerWorkspaceId,
        name: 'Source Toolkit',
        slug: 'source-toolkit',
        visibility: 'public',
        enabled: false,
        servers: { create: { deploymentId } },
        skills: { create: { installedSkillId } },
        agentLinks: { create: { agentId } },
        installLinks: {
          create: { id: `toolkit-management-install-${stamp}`, userId: ownerId },
        },
      },
    });
    const [deploymentCount, installedSkillCount] = await Promise.all([
      db.deployment.count({ where: { workspaceId: ownerWorkspaceId } }),
      db.installedSkill.count({ where: { workspaceId: ownerWorkspaceId } }),
    ]);

    await cloneToolkitAction(actionForm(ownerSlug, source.slug, '  Working Copy  '));

    const clone = await db.toolkit.findFirst({
      where: { workspaceId: ownerWorkspaceId, slug: 'working-copy' },
      include: {
        servers: true,
        skills: true,
        agentLinks: true,
        installLinks: true,
      },
    });
    expect(clone).toMatchObject({
      name: 'Working Copy',
      visibility: 'private',
      enabled: true,
    });
    expect(clone?.servers.map((link) => link.deploymentId)).toEqual([deploymentId]);
    expect(clone?.skills.map((link) => link.installedSkillId)).toEqual([installedSkillId]);
    expect(clone?.agentLinks).toHaveLength(0);
    expect(clone?.installLinks).toHaveLength(0);
    await expect(
      db.deployment.count({ where: { workspaceId: ownerWorkspaceId } }),
    ).resolves.toBe(deploymentCount);
    await expect(
      db.installedSkill.count({ where: { workspaceId: ownerWorkspaceId } }),
    ).resolves.toBe(installedSkillCount);
    await expect(db.toolkit.findUnique({ where: { id: source.id } })).resolves.not.toBeNull();
  });

  it('adds a numeric suffix when the cloned toolkit slug already exists', async () => {
    const source = await db.toolkit.create({
      data: { workspaceId: ownerWorkspaceId, name: 'Research', slug: 'research' },
    });
    await db.toolkit.create({
      data: { workspaceId: ownerWorkspaceId, name: 'Existing Copy', slug: 'research-copy' },
    });

    await cloneToolkitAction(actionForm(ownerSlug, source.slug));

    await expect(
      db.toolkit.findFirst({
        where: { workspaceId: ownerWorkspaceId, slug: 'research-copy-2' },
      }),
    ).resolves.toMatchObject({
      name: 'Research Copy 2',
      visibility: 'private',
      enabled: true,
    });
  });

  it('allocates distinct names and slugs for concurrent clones', async () => {
    const source = await db.toolkit.create({
      data: { workspaceId: ownerWorkspaceId, name: 'Concurrent', slug: 'concurrent' },
    });

    await Promise.all([
      cloneToolkitAction(actionForm(ownerSlug, source.slug)),
      cloneToolkitAction(actionForm(ownerSlug, source.slug)),
    ]);

    const clones = await db.toolkit.findMany({
      where: {
        workspaceId: ownerWorkspaceId,
        slug: { in: ['concurrent-copy', 'concurrent-copy-2'] },
      },
      orderBy: { slug: 'asc' },
      select: { name: true, slug: true },
    });
    expect(clones).toEqual([
      { name: 'Concurrent Copy', slug: 'concurrent-copy' },
      { name: 'Concurrent Copy 2', slug: 'concurrent-copy-2' },
    ]);
  });

  it('rejects cloning a toolkit with a cross-workspace resource link', async () => {
    const foreignDeployment = await db.deployment.create({
      data: {
        workspaceId: foreignWorkspaceId,
        name: 'Foreign MCP',
        source: 'npm',
        sourceRef: '@example/foreign-mcp',
        status: 'stopped',
      },
    });
    const source = await db.toolkit.create({
      data: {
        workspaceId: ownerWorkspaceId,
        name: 'Contaminated Toolkit',
        slug: 'contaminated-toolkit',
        servers: { create: { deploymentId: foreignDeployment.id } },
      },
    });

    await cloneToolkitAction(actionForm(ownerSlug, source.slug));

    await expect(
      db.toolkit.count({ where: { workspaceId: ownerWorkspaceId } }),
    ).resolves.toBe(1);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('deletes a toolkit and its links while preserving linked resources and telemetry', async () => {
    const installLinkId = `toolkit-management-delete-${stamp}`;
    const toolkit = await db.toolkit.create({
      data: {
        workspaceId: ownerWorkspaceId,
        name: 'Disposable Toolkit',
        slug: 'disposable-toolkit',
        servers: { create: { deploymentId } },
        skills: { create: { installedSkillId } },
        agentLinks: { create: { agentId } },
        installLinks: {
          create: { id: installLinkId, userId: ownerId },
        },
      },
    });
    const [invocation, syncEvent] = await Promise.all([
      db.skillInvocation.create({
        data: {
          workspaceId: ownerWorkspaceId,
          toolkitId: toolkit.id,
          skillSlug: 'shared-skill',
          source: 'toolkit',
          outcome: 'success',
        },
      }),
      db.syncEvent.create({
        data: {
          workspaceId: ownerWorkspaceId,
          toolkitId: toolkit.id,
          outcome: 'applied',
        },
      }),
    ]);
    const issued = await issueInstallToken(installLinkId, 'claude-code');
    expect(issued).not.toBeNull();
    await expect(verifyApiToken(`Bearer ${issued!.token}`)).resolves.toMatchObject({
      id: ownerId,
    });
    const legacy = await createApiToken(
      ownerId,
      `MCPmarket plugin - ${toolkit.slug} (Claude Code)`,
    );
    await expect(verifyApiToken(`Bearer ${legacy.token}`)).resolves.toMatchObject({
      id: ownerId,
    });

    await deleteToolkitAction(actionForm(ownerSlug, toolkit.slug));

    await expect(db.toolkit.findUnique({ where: { id: toolkit.id } })).resolves.toBeNull();
    await expect(db.toolkitServer.count({ where: { toolkitId: toolkit.id } })).resolves.toBe(0);
    await expect(db.toolkitSkill.count({ where: { toolkitId: toolkit.id } })).resolves.toBe(0);
    await expect(db.agentToolkit.count({ where: { toolkitId: toolkit.id } })).resolves.toBe(0);
    await expect(db.toolkitInstallLink.count({ where: { toolkitId: toolkit.id } })).resolves.toBe(0);
    await expect(db.deployment.findUnique({ where: { id: deploymentId } })).resolves.not.toBeNull();
    await expect(
      db.installedSkill.findUnique({ where: { id: installedSkillId } }),
    ).resolves.not.toBeNull();
    await expect(db.agent.findUnique({ where: { id: agentId } })).resolves.not.toBeNull();
    await expect(db.skillInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      toolkitId: null,
    });
    await expect(db.syncEvent.findUnique({ where: { id: syncEvent.id } })).resolves.toMatchObject({
      toolkitId: null,
    });
    await expect(verifyApiToken(`Bearer ${issued!.token}`)).resolves.toBeNull();
    await expect(verifyApiToken(`Bearer ${legacy.token}`)).resolves.toBeNull();
  });

  it('does not delete the default toolkit', async () => {
    const toolkit = await db.toolkit.create({
      data: { workspaceId: ownerWorkspaceId, name: 'My Toolkit', slug: 'me' },
    });

    await deleteToolkitAction(actionForm(ownerSlug, toolkit.slug));

    await expect(db.toolkit.findUnique({ where: { id: toolkit.id } })).resolves.not.toBeNull();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('allows cloning the default toolkit without replacing it', async () => {
    const toolkit = await db.toolkit.create({
      data: {
        workspaceId: ownerWorkspaceId,
        name: 'My Toolkit',
        slug: 'me',
        servers: { create: { deploymentId } },
        skills: { create: { installedSkillId } },
      },
    });

    await cloneToolkitAction(actionForm(ownerSlug, toolkit.slug));

    await expect(db.toolkit.findUnique({ where: { id: toolkit.id } })).resolves.not.toBeNull();
    const clone = await db.toolkit.findFirst({
      where: { workspaceId: ownerWorkspaceId, slug: 'my-toolkit-copy' },
      include: { servers: true, skills: true },
    });
    expect(clone).toMatchObject({
      name: 'My Toolkit Copy',
      visibility: 'private',
      enabled: true,
    });
    expect(clone?.servers.map((link) => link.deploymentId)).toEqual([deploymentId]);
    expect(clone?.skills.map((link) => link.installedSkillId)).toEqual([installedSkillId]);
  });

  it('does not mutate toolkits when the user is not signed in', async () => {
    const toolkit = await db.toolkit.create({
      data: { workspaceId: ownerWorkspaceId, name: 'Protected Toolkit', slug: 'protected-toolkit' },
    });
    mocks.getCurrentUser.mockResolvedValue(null);

    await renameToolkitAction(actionForm(ownerSlug, toolkit.slug, 'Compromised'));
    await cloneToolkitAction(actionForm(ownerSlug, toolkit.slug, 'Unauthorized Copy'));
    await deleteToolkitAction(actionForm(ownerSlug, toolkit.slug));

    await expect(db.toolkit.findUnique({ where: { id: toolkit.id } })).resolves.toMatchObject({
      name: 'Protected Toolkit',
      slug: 'protected-toolkit',
    });
    await expect(db.toolkit.count({ where: { workspaceId: ownerWorkspaceId } })).resolves.toBe(1);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('does not rename, clone, or delete a toolkit outside the authorized workspace', async () => {
    const foreignToolkit = await db.toolkit.create({
      data: { workspaceId: foreignWorkspaceId, name: 'Foreign Toolkit', slug: 'foreign-toolkit' },
    });

    for (const workspace of [ownerSlug, foreignSlug]) {
      await renameToolkitAction(actionForm(workspace, foreignToolkit.slug, 'Compromised'));
      await cloneToolkitAction(actionForm(workspace, foreignToolkit.slug, 'Foreign Copy'));
      await deleteToolkitAction(actionForm(workspace, foreignToolkit.slug));
    }

    await expect(db.toolkit.findUnique({ where: { id: foreignToolkit.id } })).resolves.toMatchObject({
      name: 'Foreign Toolkit',
      slug: 'foreign-toolkit',
    });
    await expect(db.toolkit.count({ where: { workspaceId: ownerWorkspaceId } })).resolves.toBe(0);
    await expect(db.toolkit.count({ where: { workspaceId: foreignWorkspaceId } })).resolves.toBe(1);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
