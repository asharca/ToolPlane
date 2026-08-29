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

import { listAgentMarketListings } from '@/lib/agents/market';

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
    publisherKind: 'workspace',
    publisherWorkspaceId: 'workspace-1',
    sourceAgentId: 'agent-1',
    publishedById: 'user-1',
    slug: 'researcher',
    name: 'Researcher',
    summary: null,
    iconUrl: null,
    tags: [],
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    installCount: 0,
    categories: [],
    publisherWorkspace: { slug: 'acme', name: 'Acme' },
    latestRelease: { id: 'release-1', version: 1, releaseSummary },
    ...overrides,
  };
}

describe('listAgentMarketListings', () => {
  beforeEach(() => {
    mocks.count.mockReset();
    mocks.findMany.mockReset();
  });

  it('shows platform listings but skips orphaned workspace listings', async () => {
    mocks.count.mockResolvedValue(2);
    mocks.findMany.mockResolvedValue([
      listing(),
      listing({
        id: 'platform-listing',
        publisherKind: 'platform',
        publisherWorkspaceId: null,
        sourceAgentId: null,
        publishedById: null,
        publisherWorkspace: null,
      }),
      listing({
        id: 'orphaned-listing',
        publisherKind: 'workspace',
        publisherWorkspaceId: null,
        sourceAgentId: null,
        publishedById: null,
        publisherWorkspace: null,
      }),
    ]);

    const result = await listAgentMarketListings();

    expect(mocks.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
    }));
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
    }));
    expect(result.total).toBe(2);
    expect(result.items.map(({ id }) => id)).toEqual(['listing-1', 'platform-listing']);
    expect(result.items[1]).toMatchObject({ workspaceSlug: null, workspaceName: null });
  });
});
