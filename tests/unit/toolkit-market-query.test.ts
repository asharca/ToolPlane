import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toolkitCount: vi.fn(),
  toolkitFindMany: vi.fn(),
  toolkitServerGroupBy: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    toolkit: {
      count: mocks.toolkitCount,
      findMany: mocks.toolkitFindMany,
    },
    toolkitServer: {
      groupBy: mocks.toolkitServerGroupBy,
    },
  },
}));

import { getBrowseToolkits } from '@/lib/toolkits/queries';

describe('public toolkit market query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolkitCount.mockResolvedValue(0);
    mocks.toolkitFindMany.mockResolvedValue([]);
    mocks.toolkitServerGroupBy.mockResolvedValue([]);
  });

  it('rejects an out-of-range page before issuing an OFFSET query', async () => {
    mocks.toolkitCount.mockResolvedValue(21);

    await expect(getBrowseToolkits('workspace-1', Number.MAX_SAFE_INTEGER)).resolves.toEqual({
      items: [],
      total: 21,
      pageSize: 20,
    });

    expect(mocks.toolkitFindMany).not.toHaveBeenCalled();
    expect(mocks.toolkitServerGroupBy).not.toHaveBeenCalled();
  });

  it('bounds the search term before sending it to Prisma', async () => {
    const term = 'a'.repeat(1_000);

    await getBrowseToolkits('workspace-1', 1, term);

    expect(mocks.toolkitCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { name: { contains: 'a'.repeat(160), mode: 'insensitive' } },
        ]),
      }),
    });
  });
});
