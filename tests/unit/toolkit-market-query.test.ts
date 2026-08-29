import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toolkitFindMany: vi.fn(),
  toolkitServerGroupBy: vi.fn(),
  marketListingFindMany: vi.fn(),
  marketReleaseFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    toolkit: {
      findMany: mocks.toolkitFindMany,
    },
    toolkitServer: {
      groupBy: mocks.toolkitServerGroupBy,
    },
    marketListing: { findMany: mocks.marketListingFindMany },
    marketRelease: { findMany: mocks.marketReleaseFindMany },
  },
}));

import { getBrowseToolkits } from '@/lib/toolkits/queries';

describe('public toolkit market query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolkitFindMany.mockResolvedValue([]);
    mocks.toolkitServerGroupBy.mockResolvedValue([]);
    mocks.marketListingFindMany.mockResolvedValue([]);
    mocks.marketReleaseFindMany.mockResolvedValue([]);
  });

  it('does not issue an unbounded OFFSET query for an out-of-range page', async () => {
    await expect(getBrowseToolkits('workspace-1', Number.MAX_SAFE_INTEGER)).resolves.toEqual({
      items: [],
      total: 0,
      availableTotal: 0,
      categories: [],
      pageSize: 20,
    });

    expect(mocks.toolkitFindMany).toHaveBeenCalledWith(expect.not.objectContaining({ skip: expect.anything() }));
    expect(mocks.toolkitServerGroupBy).not.toHaveBeenCalled();
  });

  it('bounds the search term before sending it to Prisma', async () => {
    const term = 'a'.repeat(1_000);

    await getBrowseToolkits('workspace-1', 1, term);

    expect(mocks.toolkitFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              { name: { contains: 'a'.repeat(160), mode: 'insensitive' } },
            ]),
          }),
        ]),
      }),
    }));
  });

  it('filters and sorts by category while returning category facets', async () => {
    mocks.toolkitFindMany.mockResolvedValue([{
      id: 'toolkit-1',
      name: 'Alpha Toolkit',
      slug: 'alpha',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      categories: [{ slug: 'developer-tools', name: 'Developer Tools' }],
      workspace: { name: 'Acme', slug: 'acme' },
      _count: { servers: 0, skills: 0 },
      servers: [],
      skills: [],
    }]);

    const result = await getBrowseToolkits('workspace-1', 1, '', {
      category: 'developer-tools',
      sort: 'name',
    });

    expect(result).toMatchObject({
      total: 1,
      availableTotal: 1,
      categories: [{ slug: 'developer-tools', name: 'Developer Tools', count: 1 }],
      items: [{ categories: [{ slug: 'developer-tools', name: 'Developer Tools' }] }],
    });
  });
});
