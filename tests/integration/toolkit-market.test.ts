// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { clonePublicToolkitAction } from '@/lib/toolkits/actions';

const stamp = Date.now();
const sourceEmail = `tk-market-source-${stamp}@test.dev`;
const targetEmail = `tk-market-target-${stamp}@test.dev`;
const sourceSlug = `tk-market-source-${stamp}`;
const targetSlug = `tk-market-target-${stamp}`;
const serverSlug = `tk-market-server-${stamp}`;
const skillSlug = `tk-market-skill-${stamp}`;

function formData(toolkitId: string): FormData {
  const fd = new FormData();
  fd.set('workspace', targetSlug);
  fd.set('toolkitId', toolkitId);
  return fd;
}

describe('toolkit market import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { slug: { in: [sourceSlug, targetSlug] } } });
    await db.user.deleteMany({ where: { email: { in: [sourceEmail, targetEmail] } } });
    await db.skill.deleteMany({ where: { slug: skillSlug } });
    await db.server.deleteMany({ where: { slug: serverSlug } });
    await db.$disconnect();
  });

  it('clones public toolkits without leaking source deployment env values', async () => {
    const [sourceUser, targetUser] = await Promise.all([
      db.user.create({ data: { email: sourceEmail, passwordHash: 'x' } }),
      db.user.create({ data: { email: targetEmail, passwordHash: 'x' } }),
    ]);
    mocks.getCurrentUser.mockResolvedValue({ id: targetUser.id, email: targetUser.email });

    const [sourceWs, targetWs] = await Promise.all([
      db.workspace.create({
        data: {
          slug: sourceSlug,
          name: 'Source',
          ownerId: sourceUser.id,
          members: { create: { userId: sourceUser.id, role: 'owner' } },
        },
      }),
      db.workspace.create({
        data: {
          slug: targetSlug,
          name: 'Target',
          ownerId: targetUser.id,
          members: { create: { userId: targetUser.id, role: 'owner' } },
        },
      }),
    ]);

    const server = await db.server.create({
      data: {
        slug: serverSlug,
        name: 'Market MCP',
        curated: true,
        verifiedAt: new Date(),
        installCfg: {
          source: 'npm',
          ref: '@modelcontextprotocol/server-memory',
          env: ['SECRET_KEY'],
          envValues: { PUBLIC_MODE: '1' },
        },
      },
    });
    const skill = await db.skill.create({
      data: {
        slug: skillSlug,
        name: 'Market Skill',
        curated: true,
        content: '---\nname: market-skill\n---\n# Market Skill',
      },
    });

    const [catalogDep, customDep, catalogSkill, customSkill] = await Promise.all([
      db.deployment.create({
        data: {
          workspaceId: sourceWs.id,
          serverId: server.id,
          status: 'running',
          source: 'npm',
          sourceRef: '@modelcontextprotocol/server-memory',
          installCfg: {
            env: {
              SECRET_KEY: 'source-secret',
              PUBLIC_MODE: 'source-overridden',
            },
          },
        },
      }),
      db.deployment.create({
        data: {
          workspaceId: sourceWs.id,
          serverId: null,
          name: 'Private MCP',
          status: 'running',
          source: 'npm',
          sourceRef: 'private-mcp',
          installCfg: { env: { PRIVATE_TOKEN: 'do-not-copy' } },
        },
      }),
      db.installedSkill.create({
        data: { workspaceId: sourceWs.id, skillId: skill.id },
      }),
      db.installedSkill.create({
        data: {
          workspaceId: sourceWs.id,
          name: 'Custom Skill',
          slug: 'custom-skill',
          description: 'Copied custom skill',
          content: '# Custom Skill',
          files: [{ path: 'reference.md', content: 'reference' }],
        },
      }),
    ]);

    const sourceToolkit = await db.toolkit.create({
      data: {
        workspaceId: sourceWs.id,
        name: 'Research Kit',
        slug: 'research-kit',
        visibility: 'public',
        servers: {
          create: [
            { deploymentId: catalogDep.id },
            { deploymentId: customDep.id },
          ],
        },
        skills: {
          create: [
            { installedSkillId: catalogSkill.id },
            { installedSkillId: customSkill.id },
          ],
        },
      },
    });

    await clonePublicToolkitAction(formData(sourceToolkit.id));

    expect(mocks.redirect).toHaveBeenCalledWith(`/app/${targetSlug}/toolkits/research-kit`);
    const targetToolkit = await db.toolkit.findFirst({
      where: { workspaceId: targetWs.id, slug: 'research-kit' },
      include: {
        servers: { include: { deployment: true } },
        skills: { include: { installedSkill: true } },
      },
    });

    expect(targetToolkit).not.toBeNull();
    expect(targetToolkit?.visibility).toBe('private');
    expect(targetToolkit?.servers).toHaveLength(1);
    const targetDeployment = targetToolkit!.servers[0].deployment;
    expect(targetDeployment.serverId).toBe(server.id);
    expect(targetDeployment.status).toBe('stopped');
    expect(targetDeployment.installCfg).toMatchObject({
      env: {
        SECRET_KEY: '',
        PUBLIC_MODE: '1',
      },
    });

    expect(targetToolkit?.skills).toHaveLength(2);
    expect(targetToolkit?.skills.some((s) => s.installedSkill.skillId === skill.id)).toBe(true);
    expect(targetToolkit?.skills.some((s) => s.installedSkill.content === '# Custom Skill')).toBe(true);
  });
});
