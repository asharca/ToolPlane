import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  categoryFindMany: vi.fn(),
  listAgentMarketListings: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    marketListing: { count: mocks.count, findMany: mocks.findMany },
    category: { findMany: mocks.categoryFindMany },
  },
}));
vi.mock('@/lib/agents/market', () => ({
  listAgentMarketListings: mocks.listAgentMarketListings,
}));

import { listMarketListingCategories, listMarketListings } from '@/lib/market/listings';

describe('market listing pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.listAgentMarketListings.mockResolvedValue({ items: [], total: 0, availableTotal: 0, page: 1, pageSize: 24 });
  });

  it.each([undefined, 0, Number.NaN])('defaults an invalid page size (%s) to 24', async (pageSize) => {
    await expect(listMarketListings({ pageSize })).resolves.toMatchObject({ pageSize: 24 });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 24 }));
  });

  it('filters exact tags and applies the requested sort', async () => {
    await listMarketListings({ kind: 'assistant', tag: ' Research ', sort: 'name' });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ kind: 'assistant', tags: { has: 'research' } }),
      orderBy: [{ isFeatured: 'desc' }, { name: 'asc' }],
    }));
  });

  it('serves agent listings from the real agent marketplace', async () => {
    mocks.listAgentMarketListings.mockResolvedValue({
      total: 1, availableTotal: 1, page: 1, pageSize: 24,
      items: [{
        id: 'agent-1', workspaceSlug: 'acme', directorySlug: 'acme-research', name: 'Research Agent',
        summary: 'Researches', iconUrl: null, tags: ['research'], categories: [{ slug: 'research', name: 'Research' }],
        curated: false, isFeatured: false, installCount: 3, publishedAt: new Date('2026-01-01'),
        latestReleaseId: 'agent-release-1', latestVersion: 2, releaseSummary: { resourceCount: 1 },
      }],
    });

    await expect(listMarketListings({ kind: 'agent', q: 'research' })).resolves.toMatchObject({
      items: [{ kind: 'agent', namespace: 'acme', slug: 'acme-research', latestRelease: { id: 'agent-release-1', version: 2 } }],
    });
    expect(mocks.listAgentMarketListings).toHaveBeenCalledWith(expect.objectContaining({ q: 'research', pageSize: 24 }));
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('filters by a real category relation and returns category metadata', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'listing-1',
      categories: [{ slug: 'research', name: 'Research' }],
    }]);

    await expect(listMarketListings({ kind: 'assistant', category: 'research' })).resolves.toMatchObject({
      items: [{ categories: [{ slug: 'research', name: 'Research' }] }],
    });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ categories: { some: { slug: 'research' } } }),
      select: expect.objectContaining({
        categories: { select: { slug: true, name: true }, orderBy: { name: 'asc' } },
      }),
    }));
  });

  it('builds category facets in descending usage order', async () => {
    mocks.categoryFindMany.mockResolvedValue([
      { slug: 'chat', name: 'Chat', _count: { marketListings: 1 } },
      { slug: 'research', name: 'Research', _count: { marketListings: 2 } },
    ]);

    await expect(listMarketListingCategories('assistant')).resolves.toEqual([
      { slug: 'research', name: 'Research', count: 2 },
      { slug: 'chat', name: 'Chat', count: 1 },
    ]);
    expect(mocks.categoryFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { marketListings: { some: expect.objectContaining({ kind: 'assistant' }) } },
    }));
  });
});
