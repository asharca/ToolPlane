import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    agentListing: {
      count: mocks.count,
      findMany: mocks.findMany,
    },
  },
}));

import { listPublicAgentListings } from '@/lib/agents/market';

const releaseSummary = {
  agentCount: 1,
  subAgentCount: 0,
  deploymentCount: 0,
  skillCount: 0,
  toolkitCount: 0,
  resourceCount: 0,
  toolCount: 0,
  models: [],
  runtimes: ['native'],
};

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing-1',
    slug: 'researcher',
    name: 'Researcher',
    summary: null,
    iconUrl: null,
    tags: [],
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    installCount: 0,
    latestVersion: 1,
    publisherWorkspace: { slug: 'acme', name: 'Acme' },
    latestRelease: { id: 'release-1', releaseSummary },
    ...overrides,
  };
}

describe('listPublicAgentListings', () => {
  beforeEach(() => {
    mocks.count.mockReset();
    mocks.findMany.mockReset();
  });

  it('filters and skips listings without a publisher workspace', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.findMany.mockResolvedValue([
      listing(),
      listing({ id: 'orphaned-listing', publisherWorkspace: null }),
    ]);

    const result = await listPublicAgentListings();

    expect(mocks.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ publisherWorkspace: { is: {} } }),
    });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ publisherWorkspace: { is: {} } }),
    }));
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'listing-1',
      workspaceSlug: 'acme',
      latestReleaseId: 'release-1',
    });
  });
});
