import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), listing: vi.fn(), release: vi.fn(), preview: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) }));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db', () => ({ db: { agentRelease: { findFirst: mocks.release } } }));
vi.mock('@/lib/admin/categories', () => ({ listCategories: async () => [] }));
vi.mock('@/lib/admin/agent-market', () => ({
  getDirectoryAgentListing: mocks.listing,
  listCatalogAgentResources: async () => ({ servers: [], skills: [] }),
  readAgentReleaseManifest: (value: unknown) => value,
}));
vi.mock('@/lib/admin/agent-market-actions', () => ({
  deleteAgentListingAction: vi.fn(), rejectAgentReleaseAction: vi.fn(),
  setAgentListingStatusAction: vi.fn(), updateAgentListingAction: vi.fn(),
}));
vi.mock('@/components/admin/AgentListingForm', () => ({ AgentListingForm: () => null }));
vi.mock('@/components/admin/ReleaseChanges', () => ({ ReleaseChanges: () => null }));
vi.mock('@/components/admin/AgentReleaseReview', () => ({ AgentReleaseReview: mocks.preview }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

import EditAgentListingPage from '@/app/admin/agents/[id]/edit/page';

describe('agent review history selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin' });
    mocks.preview.mockImplementation(({ release, canReview }) => <p>{release.name}: {canReview ? 'editable' : release.reviewNote}</p>);
    mocks.listing.mockResolvedValue({ id: 'listing', name: 'Current listing', directorySlug: 'listing', categories: [], releases: [], status: 'draft', latestRelease: null, pendingRelease: null });
    mocks.release.mockResolvedValueOnce({
      id: 'historical', name: 'Historical release', version: 1, reviewStatus: 'rejected', reviewNote: 'Missing source',
      publishedAt: new Date(), reviewedAt: new Date(), reviewedBy: { name: 'Reviewer', email: 'reviewer@test.dev' },
      manifest: { agents: [], deployments: [], skills: [], toolkits: [] }, checksum: 'checksum',
    }).mockResolvedValue(null);
  });

  it('opens the exact historical release read-only and scopes it to the listing', async () => {
    render(await EditAgentListingPage({ params: Promise.resolve({ id: 'listing' }), searchParams: Promise.resolve({ releaseId: 'historical', returnTo: '/admin/reviews?status=rejected' }) }));
    expect(screen.getByText('Historical release: Missing source')).toBeInTheDocument();
    expect(mocks.release).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { id: 'historical', listingId: 'listing' } }));
    expect(mocks.preview.mock.calls[0][0].canReview).toBe(false);
  });

  it('does not fall back to a different release for an invalid id', async () => {
    mocks.release.mockReset().mockResolvedValue(null);
    await expect(EditAgentListingPage({ params: Promise.resolve({ id: 'listing' }), searchParams: Promise.resolve({ releaseId: 'foreign-release' }) })).rejects.toThrow('not found');
  });
});
