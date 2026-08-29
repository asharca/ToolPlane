import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listMarketListings: vi.fn(),
  listMarketListingCategories: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/market/listings', () => ({
  listMarketListings: mocks.listMarketListings,
  listMarketListingCategories: mocks.listMarketListingCategories,
}));

import AssistantMarketPage from '@/app/app/[workspace]/market/assistants/page';

describe('assistant market page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1', slug: 'acme team' });
    mocks.listMarketListingCategories.mockResolvedValue([
      { slug: 'research', name: 'Research', count: 1 },
    ]);
    mocks.listMarketListings.mockResolvedValue({
      items: [{
        id: 'assistant-listing',
        kind: 'assistant',
        namespace: 'acme-labs',
        slug: 'research-chat',
        name: 'Research Chat',
        summary: 'Finds and checks sources.',
        iconUrl: null,
        tags: ['research'],
        categories: [{ slug: 'research', name: 'Research' }],
        curated: true,
        isFeatured: true,
        installCount: 7,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
        latestRelease: { id: 'release-3', version: 3, releaseSummary: {} },
      }],
      total: 1,
      availableTotal: 4,
      page: 1,
      pageSize: 24,
    });
  });

  it('filters by categories and links to the canonical assistant detail and creation flow', async () => {
    render(await AssistantMarketPage({
      params: Promise.resolve({ workspace: 'acme team' }),
      searchParams: Promise.resolve({ q: 'sources', category: 'research', sort: 'name' }),
    }));

    expect(mocks.listMarketListings).toHaveBeenCalledWith({
      kind: 'assistant',
      q: 'sources',
      category: 'research',
      sort: 'name',
      page: 1,
      pageSize: 24,
    });
    expect(screen.getByRole('link', { name: 'Research Chat' })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/assistants/acme-labs/research-chat',
    );
    expect(screen.getByRole('link', { name: /createFromTemplate/ })).toHaveAttribute(
      'href',
      '/app/acme%20team/chat?newAssistant=1&template=release-3',
    );
    expect(screen.getByRole('link', { name: /allCategories/ })).toHaveAttribute(
      'href',
      '/app/acme%20team/market/assistants?q=sources&sort=name',
    );
  });
});
