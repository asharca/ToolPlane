// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  getBrowseServers,
  getMarketServer,
  getMarketSkill,
} from '@/lib/workspace/queries';

const stamp = Date.now();
const query = `workspace-market-${stamp}`;
const email = `${query}@test.dev`;
const workspaceSlug = query;
const serverSlugs = [`${query}-valid`, `${query}-bad-recipe`, `${query}-unverified`];
const skillSlugs = [`${query}-curated`, `${query}-hidden`];
let workspaceId = '';

describe('authenticated workspace market queries', () => {
  beforeAll(async () => {
    const user = await db.user.create({ data: { email, passwordHash: 'x' } });
    const workspace = await db.workspace.create({
      data: {
        slug: workspaceSlug,
        name: 'Workspace Market Test',
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
    workspaceId = workspace.id;

    await Promise.all([
      db.server.create({
        data: {
          slug: serverSlugs[0],
          name: `${query} Valid`,
          verifiedAt: new Date(),
          installCfg: { source: 'npm', ref: '@toolplane/valid-mcp', env: ['API_KEY'] },
        },
      }),
      db.server.create({
        data: {
          slug: serverSlugs[1],
          name: `${query} Invalid recipe`,
          verifiedAt: new Date(),
          installCfg: { source: 'npm', ref: 'Bad Package Name' },
        },
      }),
      db.server.create({
        data: {
          slug: serverSlugs[2],
          name: `${query} Unverified`,
          installCfg: { source: 'npm', ref: '@toolplane/unverified-mcp' },
        },
      }),
      db.skill.create({
        data: { slug: skillSlugs[0], name: `${query} Curated`, curated: true, content: '# Approved' },
      }),
      db.skill.create({
        data: { slug: skillSlugs[1], name: `${query} Hidden`, curated: false, content: '# Hidden' },
      }),
    ]);
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { slug: workspaceSlug } });
    await db.server.deleteMany({ where: { slug: { in: serverSlugs } } });
    await db.skill.deleteMany({ where: { slug: { in: skillSlugs } } });
    await db.user.deleteMany({ where: { email } });
    await db.$disconnect();
  });

  it('lists only verified MCP entries with a valid deploy recipe', async () => {
    const result = await getBrowseServers(1, query);
    expect(result.total).toBe(1);
    expect(result.all.map((server) => server.slug)).toEqual([serverSlugs[0]]);
    expect(result.all[0].deployable).toBe(true);
  });

  it('applies the same MCP gate to internal detail pages', async () => {
    await expect(getMarketServer(serverSlugs[0], workspaceId)).resolves.toMatchObject({
      slug: serverSlugs[0],
      deploymentId: null,
      recipe: { source: 'npm', requiredEnv: ['API_KEY'] },
    });
    await expect(getMarketServer(serverSlugs[1], workspaceId)).resolves.toBeNull();
    await expect(getMarketServer(serverSlugs[2], workspaceId)).resolves.toBeNull();
  });

  it('exposes only curated skill details', async () => {
    await expect(getMarketSkill(skillSlugs[0], workspaceId)).resolves.toMatchObject({
      slug: skillSlugs[0],
      installId: null,
    });
    await expect(getMarketSkill(skillSlugs[1], workspaceId)).resolves.toBeNull();
  });
});
