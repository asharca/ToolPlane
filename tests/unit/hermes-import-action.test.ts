import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class HermesArchiveError extends Error {}
  return {
    getCurrentUser: vi.fn(),
    getWorkspaceForUser: vi.fn(),
    HermesArchiveError,
    importHermesArchive: vi.fn(),
    isHermesArchiveUpload: vi.fn(),
    redirect: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/agents/hermes/import', () => ({
  HermesArchiveError: mocks.HermesArchiveError,
  importHermesArchive: mocks.importHermesArchive,
  isHermesArchiveUpload: mocks.isHermesArchiveUpload,
}));

import { importHermesArchiveAction } from '@/lib/agents/actions';

function importForm(): FormData {
  const form = new FormData();
  form.set('workspace', 'acme');
  form.set('trustArchive', 'on');
  form.set('hermesArchive', new File(['zip'], 'backup.zip', { type: 'application/zip' }));
  return form;
}

describe('importHermesArchiveAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'workspace-1' });
    mocks.isHermesArchiveUpload.mockReturnValue(true);
    mocks.importHermesArchive.mockResolvedValue({ agentId: 'agent-1', sandboxId: 'sandbox-1' });
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    });
  });

  it('redirects after a successful import instead of converting the redirect into an error', async () => {
    await expect(importHermesArchiveAction({}, importForm())).rejects.toThrow(
      'REDIRECT:/app/acme/agents/agent-1?settings=agent&imported=hermes',
    );

    expect(mocks.importHermesArchive).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1' }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/sandboxes');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/acme/agents');
  });
});
