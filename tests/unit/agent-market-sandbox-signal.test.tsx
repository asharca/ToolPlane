import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listAgentMarketCategories: vi.fn(),
  listAgentMarketListings: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/agents/market', () => ({
  listAgentMarketCategories: mocks.listAgentMarketCategories,
  listAgentMarketListings: mocks.listAgentMarketListings,
}));

import AgentMarketPage from '@/app/app/[workspace]/market/agents/page';

describe('agent market sandbox signal', () => {
  it('shows one sandbox for every agent in the release', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.listAgentMarketCategories.mockResolvedValue([]);
    mocks.listAgentMarketListings.mockResolvedValue({
      total: 1,
      page: 1,
      pageSize: 24,
      items: [{
        id: 'listing-1',
        name: 'Research team',
        author: 'ToolPlane',
        summary: 'Researches and reviews sources.',
        iconUrl: null,
        categories: [],
        installCount: 12,
        workspaceName: 'ToolPlane',
        workspaceSlug: 'toolplane',
        releaseSummary: {
          agentCount: 3,
          subAgentCount: 2,
          deploymentCount: 1,
          skillCount: 1,
          toolkitCount: 0,
          resourceCount: 2,
          toolCount: 4,
          models: [],
          runtimes: ['pi'],
        },
      }],
    });

    render(await AgentMarketPage({
      params: Promise.resolve({ workspace: 'acme' }),
      searchParams: Promise.resolve({}),
    }));

    const sandboxStat = screen.getByText('sandboxes').closest('div');
    expect(sandboxStat).not.toBeNull();
    expect(within(sandboxStat!).getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('subAgents')).not.toBeInTheDocument();
  });
});
