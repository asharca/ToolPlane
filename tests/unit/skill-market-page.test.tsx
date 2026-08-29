import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getSkillBrowseCategories: vi.fn(),
  getBrowseSkills: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getSkillBrowseCategories: mocks.getSkillBrowseCategories,
  getBrowseSkills: mocks.getBrowseSkills,
}));
vi.mock('@/lib/workspace/actions', () => ({ installSkillAction: vi.fn() }));
vi.mock('@/components/dashboard/BrowseGrid', () => ({
  BrowseGrid: ({ items }: { items: Array<{ id: string; name: string }> }) => (
    <div data-testid="browse-grid">
      {items.map((item) => <span key={item.id}>{item.name}</span>)}
    </div>
  ),
}));

import SkillMarketPage from '@/app/app/[workspace]/market/skills/page';

const skill = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  author: null,
  description: `${name} description`,
  iconUrl: null,
  githubSource: null,
  curated: true,
  categories: [],
  installed: false,
});

describe('Skill market page', () => {
  it('renders the globally ordered skill page once', async () => {
    const featured = skill('featured', 'Featured Alpha');
    const other = skill('other', 'Other Beta');
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.getSkillBrowseCategories.mockResolvedValue([]);
    mocks.getBrowseSkills.mockResolvedValue({
      featured: [featured],
      all: [featured, other],
      total: 2,
      pageSize: 25,
    });

    render(await SkillMarketPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    }));

    const grid = screen.getByTestId('browse-grid');
    expect(grid).toHaveTextContent('Featured Alpha');
    expect(grid).toHaveTextContent('Other Beta');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps reviewed community skill releases visible after removing Discover', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.getSkillBrowseCategories.mockResolvedValue([]);
    mocks.getSkillBrowseCategories.mockResolvedValue([{ slug: 'writing', name: 'Writing', _count: { skills: 1 } }]);
    mocks.getBrowseSkills.mockResolvedValue({
      featured: [],
      all: [{
        ...skill('listing-1', 'Writer'),
        author: 'acme-labs',
        marketListing: { namespace: 'acme-labs', slug: 'writer', releaseId: 'release-1' },
      }],
      total: 1, availableTotal: 1, pageSize: 25,
    });

    render(await SkillMarketPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ q: 'writer', category: 'writing', sort: 'name' }),
    }));

    expect(mocks.getBrowseSkills).toHaveBeenCalledWith(1, 'writer', expect.objectContaining({
      category: 'writing',
      sort: 'name',
    }));
    expect(mocks.getSkillBrowseCategories).toHaveBeenCalledWith(true);
    expect(screen.getByText('Writer')).toBeInTheDocument();
  });

  it('paginates community skills after page one even when the directory page is empty', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.getSkillBrowseCategories.mockResolvedValue([]);
    mocks.getBrowseSkills.mockResolvedValue({
      featured: [], all: [skill('listing-26', 'Writer 26')], total: 26, availableTotal: 26, pageSize: 25,
    });

    render(await SkillMarketPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({ page: '2', q: 'writer' }),
    }));

    expect(mocks.getBrowseSkills).toHaveBeenCalledWith(2, 'writer', expect.any(Object));
    expect(screen.getByText('Writer 26')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'previous' })).toHaveAttribute(
      'href',
      '/app/acme/market/skills?q=writer',
    );
    expect(screen.queryByRole('link', { name: 'next' })).not.toBeInTheDocument();
  });
});
