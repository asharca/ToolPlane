import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getDefaultWorkspace: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  getAgentMarketListingByDirectorySlug: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({
  getDefaultWorkspace: mocks.getDefaultWorkspace,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  listWorkspacesForUser: mocks.listWorkspacesForUser,
}));
vi.mock('@/components/dashboard/WorkspaceAccountPage', () => ({ WorkspaceAccountPage: () => null }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'last-space' }) }) }));
vi.mock('@/lib/agents/market', () => ({
  getAgentMarketListingByDirectorySlug: mocks.getAgentMarketListingByDirectorySlug,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import AppIndexPage from '@/app/app/page';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}

describe('workspace handoff intents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((url: string) => {
      throw new RedirectSignal(url);
    });
    mocks.getDefaultWorkspace.mockResolvedValue({ slug: 'smoke' });
    mocks.listWorkspacesForUser.mockResolvedValue([{ slug: 'smoke', status: 'active' }]);
    mocks.getAgentMarketListingByDirectorySlug.mockResolvedValue(null);
  });

  it('preserves a marketplace search while sending anonymous users through login', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    await expect(AppIndexPage({
      searchParams: Promise.resolve({ market: 'mcp', q: 'not deployable' }),
    })).rejects.toMatchObject({
      url: '/app/login?next=%2Fapp%3Fmarket%3Dmcp%26q%3Dnot%2520deployable',
    });
  });

  it('routes an authenticated marketplace search into the default workspace', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'smoke@example.com' });

    await expect(AppIndexPage({
      searchParams: Promise.resolve({ market: 'skills', q: 'research helper' }),
    })).rejects.toMatchObject({
      url: '/app/smoke/market/skills?q=research%20helper',
    });

    expect(mocks.getDefaultWorkspace).toHaveBeenCalledWith(
      'user-1',
      'last-space',
    );
  });

  it('opens Chat for an authenticated user without a handoff intent', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'smoke@example.com' });

    await expect(AppIndexPage({
      searchParams: Promise.resolve({}),
    })).rejects.toMatchObject({
      url: '/app/smoke/chat',
    });
  });

  it('keeps an exact deployable server intent on its market detail route', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'smoke@example.com' });

    await expect(AppIndexPage({
      searchParams: Promise.resolve({ server: 'github-server' }),
    })).rejects.toMatchObject({
      url: '/app/smoke/market/mcp/github-server',
    });
  });

  it('preserves an agent target through login', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    await expect(AppIndexPage({
      searchParams: Promise.resolve({ agent: 'research-agent' }),
    })).rejects.toMatchObject({
      url: '/app/login?next=%2Fapp%3Fagent%3Dresearch-agent',
    });

    expect(mocks.getAgentMarketListingByDirectorySlug).not.toHaveBeenCalled();
  });

  it('resolves an agent directory slug before opening its workspace market detail', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'smoke@example.com' });
    mocks.getAgentMarketListingByDirectorySlug.mockResolvedValue({
      listing: { id: 'listing-1' },
    });

    await expect(AppIndexPage({
      searchParams: Promise.resolve({ agent: 'research-agent' }),
    })).rejects.toMatchObject({
      url: '/app/smoke/market/agents/listing-1#install',
    });

    expect(mocks.getAgentMarketListingByDirectorySlug).toHaveBeenCalledWith('research-agent');
  });

  it('ignores an unsafe agent identity', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'smoke@example.com' });

    await expect(AppIndexPage({
      searchParams: Promise.resolve({ agent: '../private' }),
    })).rejects.toMatchObject({
      url: '/app/smoke/chat',
    });

    expect(mocks.getAgentMarketListingByDirectorySlug).not.toHaveBeenCalled();
  });

  it('shows a chooser for a multi-workspace install without selecting a destination silently', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.listWorkspacesForUser.mockResolvedValue([{ slug: 'one', status: 'active' }, { slug: 'two', status: 'active' }]);
    const page = await AppIndexPage({ searchParams: Promise.resolve({ server: 'example' }) });
    expect(page.props.intent).toBe('/app?server=example');
    expect(mocks.getDefaultWorkspace).not.toHaveBeenCalled();
  });

  it('validates an explicitly selected workspace and shows an empty state when none is accessible', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    const denied = await AppIndexPage({ searchParams: Promise.resolve({ server: 'example', workspace: 'private' }) });
    expect(denied.props.notice).toBe('unavailable');
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledWith('private', 'user-1');
    mocks.getDefaultWorkspace.mockResolvedValue(null);
    const empty = await AppIndexPage({ searchParams: Promise.resolve({}) });
    expect(empty.props.user.id).toBe('user-1');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
