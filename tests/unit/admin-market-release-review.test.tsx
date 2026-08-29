import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { assistantReleaseChecksum } from '@/lib/market/assistant-manifest';
import { skillReleaseChecksum } from '@/lib/market/skill-manifest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  approveResourceMarketRelease: vi.fn(),
  rejectMarketRelease: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/db', () => ({
  db: { marketListing: { count: mocks.count, findMany: mocks.findMany } },
}));
vi.mock('@/lib/admin/categories', () => ({
  listCategories: vi.fn().mockResolvedValue([{ id: 'category-1', slug: 'research', name: 'Research' }]),
}));
vi.mock('@/lib/admin/market-catalog', () => ({
  listAdminMarketListings: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 }),
  listAdminPublicToolkits: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 }),
}));
vi.mock('@/lib/market/skills', () => ({
  rejectMarketRelease: mocks.rejectMarketRelease,
}));
vi.mock('@/lib/market/resources', () => ({
  approveResourceMarketRelease: mocks.approveResourceMarketRelease,
  parseMcpMarketManifest: vi.fn((value) => value),
  parseToolkitMarketManifest: vi.fn((value) => value),
}));
import AdminMarketPage from '@/app/admin/market/page';
import {
  approveMarketReleaseAction,
  rejectMarketReleaseAction,
} from '@/lib/admin/market-review-actions';

describe('admin market release review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ id: 'admin-1' });
    mocks.count.mockResolvedValue(1);
  });

  it('shows pending release details', async () => {
    const manifest = {
      schemaVersion: 1 as const,
      kind: 'skill' as const,
      skill: {
        name: 'Writer',
        slug: 'writer',
        description: 'Write carefully.',
        content: '# Writer\n\nCheck every claim.',
        files: [{ path: 'references/checklist.md', content: 'Review every source.' }],
        userInvocable: true,
        agentInvocable: true,
        effort: 'default',
        source: { type: 'custom' as const },
      },
    };
    mocks.findMany.mockResolvedValue([{
      id: 'listing-1',
      kind: 'skill',
      namespace: 'acme',
      slug: 'writer',
      publisherKind: 'workspace',
      name: 'Writer',
      categories: [{ id: 'category-1' }],
      publisherWorkspace: { name: 'Acme' },
      publishedBy: { name: 'Ada', email: 'ada@example.com' },
      pendingRelease: {
        id: 'release-1',
        version: 2,
        releaseNotes: 'Safer defaults',
        releaseSummary: { fileCount: 2 },
        checksum: skillReleaseChecksum(manifest),
        manifest,
        scanResult: { status: 'clean', checkedFiles: 2 },
      },
    }]);

    render(await AdminMarketPage());

    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByText('Safer defaults')).toBeInTheDocument();
    expect(screen.getByText(/"fileCount": 2/)).toBeInTheDocument();
    expect(screen.getByText(skillReleaseChecksum(manifest))).toBeInTheDocument();
    expect(screen.getByText('marketReleaseSkillMarkdown').nextElementSibling)
      .toHaveTextContent('# Writer Check every claim.');
    expect(screen.getByText('references/checklist.md').closest('details'))
      .toHaveTextContent('Review every source.');
    expect(screen.getByText('marketReleaseManifestJson').parentElement)
      .toHaveTextContent('"schemaVersion": 1');
    expect(screen.getByText('marketReleaseScanResult').parentElement)
      .toHaveTextContent('"status": "clean"');
    expect(screen.getByRole('checkbox', {
      name: /I inspected the complete checksum-covered artifact/,
    })).toBeRequired();
  });

  it('shows assistant instructions, model requirements, and MCP identities', async () => {
    const manifest = {
      schemaVersion: 1 as const,
      kind: 'assistant' as const,
      assistant: {
        name: 'Research Chat',
        systemPrompt: 'Verify every source.',
        maxSteps: 8,
        modelRequirement: { providerFormat: 'openai-compatible', model: 'gpt-5.6' },
        mcpRequirements: [{ catalogSlug: 'filesystem', name: 'Filesystem MCP' }],
      },
    };
    mocks.findMany.mockResolvedValue([{
      id: 'listing-assistant',
      kind: 'assistant',
      namespace: 'acme',
      slug: 'research-chat',
      publisherKind: 'workspace',
      name: 'Research Chat',
      categories: [{ id: 'category-1' }],
      publisherWorkspace: { name: 'Acme' },
      publishedBy: { name: 'Ada', email: 'ada@example.com' },
      pendingRelease: {
        id: 'release-assistant',
        version: 1,
        releaseNotes: 'First version',
        releaseSummary: { mcpCount: 1 },
        checksum: assistantReleaseChecksum(manifest),
        manifest,
        scanResult: { status: 'clean' },
      },
    }]);

    render(await AdminMarketPage());

    expect(screen.getByText('Verify every source.')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.6')).toBeInTheDocument();
    expect(screen.getByText('Filesystem MCP')).toBeInTheDocument();
    expect(screen.getByText('filesystem')).toBeInTheDocument();
    expect(screen.queryByText('errorInvalidMarketRelease')).not.toBeInTheDocument();
  });

  it('paginates pending manifests and previews MCP and toolkit resources', async () => {
    mocks.count.mockResolvedValue(12);
    mocks.findMany.mockResolvedValue([
      {
        id: 'listing-mcp', kind: 'mcp', namespace: 'acme', slug: 'search', publisherKind: 'workspace', name: 'Search MCP',
        categories: [{ id: 'category-1' }], publisherWorkspace: { name: 'Acme' }, publishedBy: null,
        pendingRelease: {
          id: 'release-mcp', version: 2, releaseNotes: null, releaseSummary: {}, checksum: 'mcp', scanResult: null,
          manifest: {
            kind: 'mcp',
            mcp: {
              recipe: { source: 'npm', ref: '@acme/search', env: ['SEARCH_KEY'] },
              toolExposure: 'allowlist',
              allowedTools: ['search'],
            },
          },
        },
      },
      {
        id: 'listing-toolkit', kind: 'toolkit', namespace: 'acme', slug: 'research', publisherKind: 'workspace', name: 'Research Kit',
        categories: [{ id: 'category-1' }], publisherWorkspace: { name: 'Acme' }, publishedBy: null,
        pendingRelease: {
          id: 'release-toolkit', version: 1, releaseNotes: null, releaseSummary: {}, checksum: 'toolkit', scanResult: null,
          manifest: {
            kind: 'toolkit',
            mcps: [{ catalogSlug: 'filesystem', name: 'Filesystem', recipe: { env: ['ROOT'] } }],
            skills: [{ catalogSlug: 'writer', snapshot: { slug: 'writer', name: 'Writer' } }],
          },
        },
      },
    ]);

    render(await AdminMarketPage({ searchParams: Promise.resolve({ pendingPage: '2' }) }));

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
    expect(screen.getAllByText('@acme/search', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText('SEARCH_KEY')).toBeInTheDocument();
    expect(screen.getByText('Filesystem')).toBeInTheDocument();
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByText('page 2 / 3', { exact: false })).toBeInTheDocument();
  });

  it('requires an admin and explicit confirmation for approval only', async () => {
    const approveForm = new FormData();
    approveForm.set('listingId', 'listing-1');
    approveForm.set('releaseId', 'release-1');
    await expect(approveMarketReleaseAction({}, approveForm)).resolves.toEqual({
      error: 'errorMarketReleaseReviewConfirmationRequired',
    });
    expect(mocks.approveResourceMarketRelease).not.toHaveBeenCalled();

    approveForm.set('reviewConfirmed', 'yes');
    approveForm.append('categoryIds', 'category-1');
    await approveMarketReleaseAction({}, approveForm);

    const rejectForm = new FormData();
    rejectForm.set('listingId', 'listing-1');
    rejectForm.set('releaseId', 'release-2');
    rejectForm.set('reviewNote', '  Needs changes  ');
    await rejectMarketReleaseAction({}, rejectForm);

    expect(mocks.requireAdmin).toHaveBeenCalledTimes(3);
    expect(mocks.approveResourceMarketRelease).toHaveBeenCalledWith({
      listingId: 'listing-1',
      releaseId: 'release-1',
      reviewedById: 'admin-1',
      reviewNote: null,
      categoryIds: ['category-1'],
    });
    expect(mocks.rejectMarketRelease).toHaveBeenCalledWith({
      listingId: 'listing-1',
      releaseId: 'release-2',
      reviewedById: 'admin-1',
      reviewNote: 'Needs changes',
    });
  });
});
