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
const serverSlugs = [
  `${query}-valid`,
  `${query}-bad-recipe`,
  `${query}-unverified`,
  `${query}-missing-catalog`,
  `${query}-empty-catalog`,
  `${query}-connector`,
];
const skillSlugs = [`${query}-curated`, `${query}-hidden`];
const categorySlug = `${query}-search`;
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
          verifiedTools: 1,
          installCfg: {
            source: 'npm',
            ref: '@toolplane/valid-mcp',
            env: ['API_KEY'],
            toolCatalog: [{
              name: 'search',
              description: 'Search the workspace index.',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            }],
          },
          readme: 'Imported from https://www.npmjs.com/package/@toolplane/valid-mcp\n\nRepository: https://github.com/toolplane/valid-mcp',
          categories: { create: { slug: categorySlug, name: 'Search' } },
          deployments: {
            create: {
              workspaceId,
              source: 'npm',
              sourceRef: '@toolplane/valid-mcp',
              status: 'stopped',
              installCfg: {
                env: { API_KEY: 'workspace-secret' },
                toolCatalog: [{
                  name: 'workspace_search',
                  description: 'Workspace-specific runtime snapshot.',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                }],
              },
            },
          },
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
      db.server.create({
        data: {
          slug: serverSlugs[3],
          name: `${query} Missing catalog`,
          verifiedAt: new Date(),
          verifiedTools: 3,
          installCfg: { source: 'npm', ref: '@toolplane/missing-catalog-mcp' },
        },
      }),
      db.server.create({
        data: {
          slug: serverSlugs[4],
          name: `${query} Empty catalog`,
          verifiedAt: new Date(),
          verifiedTools: 0,
          installCfg: { source: 'npm', ref: '@toolplane/empty-catalog-mcp', toolCatalog: [] },
        },
      }),
      db.server.create({
        data: {
          slug: serverSlugs[5],
          name: `${query} Remote connector`,
          verifiedAt: new Date(),
          verifiedTools: 1,
          installCfg: {
            source: 'remote',
            ref: 'https://connector.example.test/mcp',
            sourceUrl: 'https://github.com/toolplane/example-connector',
            transport: 'sse',
            authType: 'bearer',
            bearerEnv: 'REMOTE_TOKEN',
            toolCatalog: [{
              name: 'remote_search',
              description: 'Search a hosted catalog.',
              inputSchema: { type: 'object', properties: {} },
            }],
          },
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
    await db.category.deleteMany({ where: { slug: categorySlug } });
    await db.user.deleteMany({ where: { email } });
    await db.$disconnect();
  });

  it('lists only verified MCP entries with a valid recipe and a captured catalog', async () => {
    const result = await getBrowseServers(1, query);
    expect(result.total).toBe(3);
    expect(result.all.map((server) => server.slug)).toEqual(expect.arrayContaining([
      serverSlugs[0],
      serverSlugs[4],
      serverSlugs[5],
    ]));
    expect(result.all.every((server) => server.deployable)).toBe(true);
    expect(result.all.map((server) => server.slug)).not.toContain(serverSlugs[3]);
  });

  it('separates deployable servers from hosted connectors', async () => {
    const [servers, connectors] = await Promise.all([
      getBrowseServers(1, query, { type: 'server' }),
      getBrowseServers(1, query, { type: 'connector' }),
    ]);
    expect(servers.all.map(({ slug }) => slug)).toEqual(expect.arrayContaining([serverSlugs[0], serverSlugs[4]]));
    expect(servers.all.every(({ mcpKind }) => mcpKind === 'server')).toBe(true);
    expect(connectors.all.map(({ slug, mcpKind }) => ({ slug, mcpKind }))).toEqual([
      { slug: serverSlugs[5], mcpKind: 'connector' },
    ]);
  });

  it('filters MCP entries by category and exposes facet counts', async () => {
    const result = await getBrowseServers(1, query, { category: categorySlug, sort: 'name' });
    expect(result.all.map((server) => server.slug)).toEqual([serverSlugs[0]]);
    expect(result.categories).toContainEqual({ slug: categorySlug, name: 'Search', count: 1 });
    await expect(getBrowseServers(1, query, { category: 'missing' }))
      .resolves.toMatchObject({ total: 0, all: [] });
  });

  it('applies the same MCP gate to internal detail pages', async () => {
    const detail = await getMarketServer(serverSlugs[0], workspaceId);
    expect(detail).toMatchObject({
      slug: serverSlugs[0],
      deploymentId: expect.any(String),
      deploymentStatus: 'stopped',
      toolCatalogKnown: true,
      tools: [{ name: 'search' }],
      inspectorSandbox: null,
      sourceUrl: 'https://github.com/toolplane/valid-mcp',
      mcpKind: 'server',
      recipe: { source: 'npm', requiredEnv: ['API_KEY'] },
    });
    expect(JSON.stringify(detail)).not.toContain('workspace-secret');
    await expect(getMarketServer(serverSlugs[1], workspaceId)).resolves.toBeNull();
    await expect(getMarketServer(serverSlugs[2], workspaceId)).resolves.toBeNull();
    await expect(getMarketServer(serverSlugs[3], workspaceId)).resolves.toBeNull();
    await expect(getMarketServer(serverSlugs[4], workspaceId)).resolves.toMatchObject({
      slug: serverSlugs[4],
      toolCatalogKnown: true,
      tools: [],
    });
    await expect(getMarketServer(serverSlugs[5], workspaceId)).resolves.toMatchObject({
      slug: serverSlugs[5],
      mcpKind: 'connector',
      sourceUrl: 'https://github.com/toolplane/example-connector',
      connector: {
        endpointHost: 'connector.example.test',
        transport: 'sse',
        authType: 'bearer',
      },
      recipe: { source: 'remote', requiredEnv: ['REMOTE_TOKEN'] },
      toolCatalogKnown: false,
      tools: [],
      inspectorSandbox: null,
    });
  });

  it('exposes only curated skill details', async () => {
    await expect(getMarketSkill(skillSlugs[0], workspaceId)).resolves.toMatchObject({
      slug: skillSlugs[0],
      installId: null,
    });
    await expect(getMarketSkill(skillSlugs[1], workspaceId)).resolves.toBeNull();
  });
});
