import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getOrCreateDefaultWorkspace: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({
  getOrCreateDefaultWorkspace: mocks.getOrCreateDefaultWorkspace,
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
    mocks.getOrCreateDefaultWorkspace.mockResolvedValue({ slug: 'smoke' });
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

    expect(mocks.getOrCreateDefaultWorkspace).toHaveBeenCalledWith(
      'user-1',
      'smoke@example.com',
    );
  });

  it('keeps an exact deployable server intent on its market detail route', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'smoke@example.com' });

    await expect(AppIndexPage({
      searchParams: Promise.resolve({ server: 'github-server' }),
    })).rejects.toMatchObject({
      url: '/app/smoke/market/mcp/github-server',
    });
  });
});
