// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import {
  listCategories,
  createCategory,
  deleteCategory,
  updateCategory,
} from '@/lib/admin/categories';

const stamp = Date.now();

describe('admin categories', () => {
  it('creates, lists, and deletes an empty category', async () => {
    const c = await createCategory(`cat-${stamp}`, `Cat ${stamp}`);
    await updateCategory(c.id, `Renamed ${stamp}`);
    const listed = (await listCategories()).find((x) => x.id === c.id);
    expect(listed?.name).toBe(`Renamed ${stamp}`);
    await deleteCategory(c.id);
    expect(await db.category.findUnique({ where: { id: c.id } })).toBeNull();
  });

  it('refuses to delete a non-empty category', async () => {
    const c = await createCategory(`catx-${stamp}`, `CatX ${stamp}`);
    const skill = await db.skill.create({ data: { slug: `cs-${stamp}`, name: 'cs', categories: { connect: { id: c.id } } } });
    await expect(deleteCategory(c.id)).rejects.toThrow(/not empty/i);
    await db.skill.delete({ where: { id: skill.id } });
    await deleteCategory(c.id);
  });

  it('counts agent listings as directory items when guarding deletion', async () => {
    const c = await createCategory(`cata-${stamp}`, `CatA ${stamp}`);
    const listing = await db.agentListing.create({
      data: {
        slug: `category-agent-${stamp}`,
        directorySlug: `category-agent-${stamp}`,
        name: 'Category Agent',
        categories: { connect: { id: c.id } },
      },
    });
    await expect(deleteCategory(c.id)).rejects.toThrow(/not empty/i);
    await db.agentListing.delete({ where: { id: listing.id } });
    await deleteCategory(c.id);
  });

  it('guards categories used by unified listings and public toolkits', async () => {
    const c = await createCategory(`catm-${stamp}`, `CatM ${stamp}`);
    const listing = await db.marketListing.create({
      data: {
        kind: 'assistant',
        namespace: `catm-${stamp}`,
        slug: 'assistant',
        name: 'Assistant',
        metadata: {},
        categories: { connect: { id: c.id } },
      },
    });
    await expect(deleteCategory(c.id)).rejects.toThrow(/not empty/i);
    await db.marketListing.delete({ where: { id: listing.id } });

    const user = await db.user.create({
      data: { email: `catm-${stamp}@test.dev`, passwordHash: 'x' },
    });
    const workspace = await db.workspace.create({
      data: { slug: `catm-${stamp}`, name: 'Category Toolkit', ownerId: user.id },
    });
    const toolkit = await db.toolkit.create({
      data: {
        workspaceId: workspace.id,
        slug: 'public-kit',
        name: 'Public Kit',
        visibility: 'public',
        categories: { connect: { id: c.id } },
      },
    });
    await expect(deleteCategory(c.id)).rejects.toThrow(/not empty/i);
    await db.toolkit.delete({ where: { id: toolkit.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await deleteCategory(c.id);
  });

  it('counts a catalog MCP listing and its source server once', async () => {
    const c = await createCategory(`catd-${stamp}`, `CatD ${stamp}`);
    const server = await db.server.create({
      data: {
        slug: `category-mcp-${stamp}`,
        name: 'Category MCP',
        categories: { connect: { id: c.id } },
      },
    });
    const listing = await db.marketListing.create({
      data: {
        kind: 'mcp',
        namespace: `catd-${stamp}`,
        slug: 'category-mcp',
        name: 'Category MCP',
        metadata: {},
        sourceServerId: server.id,
        categories: { connect: { id: c.id } },
      },
    });

    const listed = (await listCategories()).find(({ id }) => id === c.id);
    expect(listed?._count.servers).toBe(1);

    await db.marketListing.delete({ where: { id: listing.id } });
    await db.server.delete({ where: { id: server.id } });
    await deleteCategory(c.id);
  });
});
