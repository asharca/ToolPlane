import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  listWorkspacesForUser: vi.fn(),
}));
vi.mock('next-intl/server', () => ({ getMessages: vi.fn() }));
vi.mock('@/components/dashboard/DashboardChrome', () => ({ DashboardChrome: () => null }));
vi.mock('@/components/timezone/UserTimeZoneProvider', () => ({ UserTimeZoneProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/lib/site-runtime', () => ({ runtimeSupportEmail: () => 'support@example.com' }));

import WorkspaceLayout from '@/app/app/[workspace]/layout';

class RedirectSignal extends Error {
  constructor(readonly url: string) { super(url); }
}

describe('workspace login redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((url: string) => { throw new RedirectSignal(url); });
    mocks.getCurrentUser.mockResolvedValue(null);
  });

  it('returns an anonymous work-page visitor to the same page after login', async () => {
    await expect(WorkspaceLayout({
      params: Promise.resolve({ workspace: '4sharca' }),
      children: null,
      modal: null,
    })).rejects.toMatchObject({
      url: '/app/login?next=%2Fapp%2F4sharca%2Fwork',
    });
  });
});
