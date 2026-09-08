import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), workspace: vi.fn(), deleteUser: vi.fn(), deleteWorkspace: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: mocks.auth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.user }, workspace: { findUnique: mocks.workspace } } }));
vi.mock('@/lib/admin/users', () => ({ deleteManagedUser: mocks.deleteUser, setUserRole: vi.fn(), setUserStatus: vi.fn() }));
vi.mock('@/lib/admin/workspaces', () => ({ deleteManagedWorkspace: mocks.deleteWorkspace }));
import { deleteUserAction } from '@/lib/admin/user-actions';
import { deleteWorkspaceAdminAction } from '@/lib/admin/workspace-actions';

describe('administrator deletion confirmation', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ id: 'admin-1' }); });
  it('does not trust the submitted email or slug', async () => {
    mocks.user.mockResolvedValue({ email: 'real@example.com' });
    mocks.workspace.mockResolvedValue({ slug: 'real-workspace' });
    const data = new FormData();
    for (const key of ['userId', 'workspaceId', 'confirm', 'email', 'slug']) data.set(key, 'forged');
    expect(await deleteUserAction({}, data)).toEqual({ error: 'errorTypeEmail' });
    expect(await deleteWorkspaceAdminAction({}, data)).toEqual({ error: 'errorTypeSlug' });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
  });
  it('requires authorization before reading confirmation data or deleting', async () => {
    mocks.auth.mockRejectedValue(new Error('Forbidden'));
    await expect(deleteUserAction({}, new FormData())).rejects.toThrow('Forbidden');
    await expect(deleteWorkspaceAdminAction({}, new FormData())).rejects.toThrow('Forbidden');
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});
