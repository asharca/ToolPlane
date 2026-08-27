import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

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
  it('uses cards at every viewport and does not repeat featured skills in all skills', async () => {
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

    const grids = screen.getAllByTestId('browse-grid');
    expect(grids).toHaveLength(2);
    expect(within(grids[0]).getByText('Featured Alpha')).toBeInTheDocument();
    expect(within(grids[1]).queryByText('Featured Alpha')).not.toBeInTheDocument();
    expect(within(grids[1]).getByText('Other Beta')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
