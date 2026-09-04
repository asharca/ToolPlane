// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  createAdminAssistantTemplate,
  deleteAdminAssistantTemplate,
  getAdminAssistantTemplate,
  listAdminMarketListings,
  updateAdminAssistantTemplate,
  updateAdminMarketListing,
  updateAdminPublicToolkit,
} from '@/lib/admin/market-catalog';
import { getBrowseToolkits } from '@/lib/toolkits/queries';
import { getBrowseServers } from '@/lib/workspace/queries';
import { listMarketListings } from '@/lib/market/listings';
import { getAssistantMarketTemplate } from '@/lib/market/skills';
import { marketReleaseChecksum } from '@/lib/market/artifact';

const stamp = `${process.pid}-${Date.now()}`;
let categoryId = '';
let secondCategoryId = '';
let listingId = '';
let toolkitId = '';
let workspaceId = '';
let userId = '';

describe.sequential('admin marketplace catalog management', () => {
  beforeAll(async () => {
    const [category, secondCategory, user] = await Promise.all([
      db.category.create({ data: { slug: `catalog-${stamp}`, name: 'Catalog' } }),
      db.category.create({ data: { slug: `catalog-second-${stamp}`, name: 'Catalog second' } }),
      db.user.create({ data: { email: `catalog-${stamp}@test.dev`, passwordHash: 'x', role: 'admin' } }),
    ]);
    categoryId = category.id;
    secondCategoryId = secondCategory.id;
    userId = user.id;
    const workspace = await db.workspace.create({
      data: { slug: `catalog-${stamp}`, name: 'Catalog', ownerId: user.id },
    });
    workspaceId = workspace.id;
    const [listing, toolkit] = await Promise.all([
      db.marketListing.create({
        data: {
          kind: 'assistant',
          namespace: workspace.slug,
          slug: 'catalog-assistant',
          name: 'Catalog Assistant',
          metadata: {},
        },
      }),
      db.toolkit.create({
        data: {
          workspaceId: workspace.id,
          slug: 'catalog-toolkit',
          name: 'Catalog Toolkit',
          visibility: 'public',
        },
      }),
    ]);
    listingId = listing.id;
    toolkitId = toolkit.id;
  });

  afterAll(async () => {
    if (listingId) await db.marketListing.deleteMany({ where: { id: listingId } });
    if (toolkitId) await db.toolkit.deleteMany({ where: { id: toolkitId } });
    if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } });
    if (categoryId) await db.category.deleteMany({ where: { id: categoryId } });
    if (secondCategoryId) await db.category.deleteMany({ where: { id: secondCategoryId } });
    if (userId) await db.user.deleteMany({ where: { id: userId } });
  });

  it('updates listing flags and validated categories', async () => {
    await updateAdminMarketListing({
      id: listingId,
      status: 'disabled',
      curated: true,
      isFeatured: true,
      categoryIds: [categoryId],
    });
    const listing = await db.marketListing.findUnique({
      where: { id: listingId },
      include: { categories: true },
    });
    expect(listing).toMatchObject({ status: 'disabled', curated: true, isFeatured: true });
    expect(listing?.categories.map(({ id }) => id)).toEqual([categoryId]);
  });

  it('filters the unified catalog to assistant listings', async () => {
    const result = await listAdminMarketListings({ kind: 'assistant' });
    expect(result.items.some(({ id }) => id === listingId)).toBe(true);
    expect(result.items.every(({ kind }) => kind === 'assistant')).toBe(true);
  });

  it('requires an approved release before publishing', async () => {
    await expect(updateAdminMarketListing({
      id: listingId,
      status: 'published',
      curated: false,
      isFeatured: false,
      categoryIds: [],
    })).rejects.toMatchObject({ code: 'release_required' });
  });

  it('updates only existing public toolkits with valid categories', async () => {
    await updateAdminPublicToolkit({ id: toolkitId, enabled: false, categoryIds: [categoryId] });
    const toolkit = await db.toolkit.findUnique({
      where: { id: toolkitId },
      include: { categories: true },
    });
    expect(toolkit?.enabled).toBe(false);
    expect(toolkit?.categories.map(({ id }) => id)).toEqual([categoryId]);

    await expect(updateAdminPublicToolkit({
      id: toolkitId,
      enabled: true,
      categoryIds: ['missing'],
    })).rejects.toMatchObject({ code: 'invalid_categories' });
  });

  it('creates a real approved assistant template and immediately reflects admin changes', async () => {
    const server = await db.server.create({
      data: {
        slug: `catalog-assistant-mcp-${stamp}`,
        name: 'Assistant MCP',
        verifiedAt: new Date(),
        verifiedTools: 0,
        installCfg: {
          source: 'npm',
          ref: '@modelcontextprotocol/server-everything',
          env: [],
          toolCatalog: [],
        },
      },
    });
    const slug = `platform-assistant-${stamp}`;
    const created = await createAdminAssistantTemplate({
      slug,
      name: 'Platform Assistant',
      author: 'ToolPlane',
      summary: 'A reviewed assistant template.',
      iconUrl: null,
      tags: ['Research', 'research'],
      categoryIds: [categoryId],
      status: 'published',
      isFeatured: true,
      systemPrompt: 'Research carefully.',
      maxSteps: 8,
      modelFormat: 'openai-compatible',
      model: 'gpt-test',
      serverIds: [server.id],
    }, userId);

    const [template, initial] = await Promise.all([
      getAssistantMarketTemplate(created.releaseId),
      listMarketListings({ kind: 'assistant', category: `catalog-${stamp}` }),
    ]);
    expect(template).toMatchObject({
      releaseId: created.releaseId,
      listing: { namespace: 'toolplane', slug },
      manifest: {
        kind: 'assistant',
        assistant: { mcpRequirements: [{ catalogSlug: server.slug }] },
      },
    });
    expect(initial.items.map(({ id }) => id)).toContain(created.id);
    expect(await db.marketRelease.findUnique({
      where: { id: created.releaseId },
      select: { categoryIds: true },
    })).toEqual({ categoryIds: [categoryId] });

    const updated = await updateAdminAssistantTemplate(created.id, {
      slug,
      name: 'Platform Assistant v2',
      author: 'ToolPlane',
      summary: 'A reviewed assistant template with a second version.',
      iconUrl: null,
      tags: ['research', 'updated'],
      categoryIds: [secondCategoryId],
      status: 'published',
      isFeatured: false,
      systemPrompt: 'Research carefully and cite sources.',
      maxSteps: 1000,
      modelFormat: 'openai-compatible',
      model: 'gpt-test',
      serverIds: [server.id],
    }, userId);
    const updatedTemplate = await getAdminAssistantTemplate(created.id);
    expect(updatedTemplate).toMatchObject({
      listing: { latestVersion: 2, name: 'Platform Assistant v2' },
      manifest: { assistant: { systemPrompt: 'Research carefully and cite sources.', maxSteps: 1000 } },
    });
    expect(await db.marketRelease.findUnique({
      where: { id: updated.latestReleaseId! },
      select: { categoryIds: true },
    })).toEqual({ categoryIds: [secondCategoryId] });

    await updateAdminMarketListing({
      id: created.id,
      status: 'published',
      curated: true,
      isFeatured: false,
      categoryIds: [secondCategoryId],
    });
    const [oldCategory, newCategory] = await Promise.all([
      listMarketListings({ kind: 'assistant', category: `catalog-${stamp}` }),
      listMarketListings({ kind: 'assistant', category: `catalog-second-${stamp}` }),
    ]);
    expect(oldCategory.items.map(({ id }) => id)).not.toContain(created.id);
    expect(newCategory.items.map(({ id }) => id)).toContain(created.id);

    await updateAdminMarketListing({
      id: created.id,
      status: 'disabled',
      curated: true,
      isFeatured: false,
      categoryIds: [secondCategoryId],
    });
    expect((await listMarketListings({ kind: 'assistant' })).items.map(({ id }) => id))
      .not.toContain(created.id);

    await deleteAdminAssistantTemplate(created.id);
    expect(await getAdminAssistantTemplate(created.id)).toBeNull();
    await db.server.delete({ where: { id: server.id } });
  });

  it('cascades unified MCP and toolkit status and categories to their user-facing sources', async () => {
    await db.toolkit.update({
      where: { id: toolkitId },
      data: {
        enabled: true,
        categories: { set: [{ id: categoryId }] },
      },
    });
    const server = await db.server.create({
      data: {
        slug: `catalog-cascade-mcp-${stamp}`,
        name: 'Cascade MCP',
        verifiedAt: new Date(),
        installCfg: { source: 'npm', ref: '@modelcontextprotocol/server-everything', env: [] },
        categories: { connect: { id: categoryId } },
      },
    });
    const mcpListing = await db.marketListing.create({
      data: {
        kind: 'mcp',
        namespace: `catalog-cascade-${stamp}`,
        slug: 'mcp',
        name: 'Cascade MCP',
        metadata: {},
        status: 'disabled',
        sourceServerId: server.id,
        categories: { connect: { id: categoryId } },
      },
    });
    const mcpManifest = {
      schemaVersion: 1,
      kind: 'mcp',
      listing: { slug: 'mcp', name: 'Cascade MCP', summary: null, iconUrl: null, tags: [], author: 'Catalog' },
      mcp: {
        name: 'Cascade MCP', slug: 'mcp', description: null, author: 'Catalog', iconUrl: null, readme: null,
        catalogSlug: server.slug,
        recipe: { source: 'npm', ref: '@modelcontextprotocol/server-everything', env: [] },
        toolExposure: 'all', allowedTools: [],
      },
    } as const;
    const mcpRelease = await db.marketRelease.create({
      data: {
        listingId: mcpListing.id,
        version: 1,
        manifest: mcpManifest,
        releaseSummary: {},
        checksum: marketReleaseChecksum(mcpManifest),
        reviewStatus: 'approved',
      },
    });
    await db.marketListing.update({
      where: { id: mcpListing.id },
      data: { latestVersion: 1, latestReleaseId: mcpRelease.id },
    });

    await expect(updateAdminMarketListing({
      id: mcpListing.id,
      status: 'published',
      curated: false,
      isFeatured: false,
      categoryIds: [categoryId],
    })).rejects.toMatchObject({ code: 'invalid_config' });
    await db.server.update({
      where: { id: server.id },
      data: {
        verifiedTools: 0,
        installCfg: {
          source: 'npm',
          ref: '@modelcontextprotocol/server-everything',
          env: [],
          toolCatalog: [],
        },
      },
    });
    await updateAdminMarketListing({
      id: mcpListing.id,
      status: 'published',
      curated: false,
      isFeatured: false,
      categoryIds: [categoryId],
    });

    const toolkitListing = await db.marketListing.create({
      data: {
        kind: 'toolkit',
        namespace: `catalog-cascade-${stamp}`,
        slug: 'toolkit',
        name: 'Catalog Toolkit',
        metadata: { mcpCount: 0, skillCount: 0 },
        status: 'published',
        sourceToolkitId: toolkitId,
        categories: { connect: { id: categoryId } },
      },
    });
    const toolkitManifest = {
      schemaVersion: 1,
      kind: 'toolkit',
      listing: { slug: 'toolkit', name: 'Catalog Toolkit', summary: null, iconUrl: null, tags: [], author: 'Catalog' },
      toolkit: { name: 'Catalog Toolkit', slug: 'catalog-toolkit' },
      mcps: [],
      skills: [],
    } as const;
    const toolkitRelease = await db.marketRelease.create({
      data: {
        listingId: toolkitListing.id,
        version: 1,
        manifest: toolkitManifest,
        releaseSummary: {},
        checksum: marketReleaseChecksum(toolkitManifest),
        reviewStatus: 'approved',
      },
    });
    await db.marketListing.update({
      where: { id: toolkitListing.id },
      data: { latestVersion: 1, latestReleaseId: toolkitRelease.id },
    });

    expect((await getBrowseServers(1, server.slug)).all.map(({ id }) => id)).toContain(server.id);
    expect((await getBrowseToolkits('outside-workspace', 1, 'Catalog Toolkit')).items.map(({ id }) => id))
      .toContain(toolkitId);
    await Promise.all([
      updateAdminMarketListing({
        id: mcpListing.id,
        status: 'disabled',
        curated: false,
        isFeatured: false,
        categoryIds: [secondCategoryId],
      }),
      updateAdminMarketListing({
        id: toolkitListing.id,
        status: 'disabled',
        curated: false,
        isFeatured: false,
        categoryIds: [secondCategoryId],
      }),
    ]);
    const [updatedServer, updatedToolkit, browsedServers, browsedToolkits] = await Promise.all([
      db.server.findUniqueOrThrow({ where: { id: server.id }, include: { categories: true } }),
      db.toolkit.findUniqueOrThrow({ where: { id: toolkitId }, include: { categories: true } }),
      getBrowseServers(1, server.slug),
      getBrowseToolkits('outside-workspace', 1, 'Catalog Toolkit'),
    ]);
    expect(updatedServer.verifiedAt).not.toBeNull();
    expect(updatedServer.categories.map(({ id }) => id)).toEqual([secondCategoryId]);
    expect(updatedToolkit.enabled).toBe(false);
    expect(updatedToolkit.categories.map(({ id }) => id)).toEqual([secondCategoryId]);
    expect(browsedServers.all.map(({ id }) => id)).not.toContain(server.id);
    expect(browsedToolkits.items.map(({ id }) => id)).not.toContain(toolkitId);

    await db.marketListing.deleteMany({ where: { id: { in: [mcpListing.id, toolkitListing.id] } } });
    await db.server.delete({ where: { id: server.id } });
  });
});
