// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/headers cookies
const mockSet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ set: mockSet })),
}));

// Mock next/cache
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mock auth session — default: no logged-in user
vi.mock('@/lib/auth/session', () => ({
  getSessionUserId: vi.fn(() => Promise.resolve(null)),
}));

// Mock DB — won't be called unless user is logged in
vi.mock('@/lib/db', () => ({
  db: { user: { update: vi.fn() } },
}));

describe('setLocale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes NEXT_LOCALE cookie with 1-year maxAge', async () => {
    const { setLocale } = await import('@/lib/i18n/actions');
    await setLocale('zh');

    expect(mockSet).toHaveBeenCalledWith('NEXT_LOCALE', 'zh', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  });

  it('does not update DB when user is not logged in', async () => {
    const { db } = await import('@/lib/db');
    const { setLocale } = await import('@/lib/i18n/actions');
    await setLocale('en');

    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('updates User.locale in DB when user is logged in', async () => {
    const { getSessionUserId } = await import('@/lib/auth/session');
    vi.mocked(getSessionUserId).mockResolvedValueOnce('user-123');
    const { db } = await import('@/lib/db');
    const { setLocale } = await import('@/lib/i18n/actions');
    await setLocale('zh');

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: { locale: 'zh' },
    });
  });
});
