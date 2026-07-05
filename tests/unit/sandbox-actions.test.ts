import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  sandboxFindFirst: vi.fn(),
  sandboxUpdate: vi.fn(),
  deploymentUpdate: vi.fn(),
  transaction: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    sandbox: {
      findFirst: mocks.sandboxFindFirst,
      update: mocks.sandboxUpdate,
    },
    deployment: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      update: mocks.deploymentUpdate,
    },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  restartProcess: vi.fn(),
  killProcess: vi.fn(),
}));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: vi.fn() }));
vi.mock('@/lib/sandboxes/runtime', () => ({
  DEFAULT_SANDBOX_IMAGE: 'node:24-bookworm-slim',
  removeDockerSandboxRuntime: vi.fn(),
  sandboxVolumeName: (id: string) => `toolplane-sandbox-${id}`,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { renameSandboxAction } from '@/lib/sandboxes/actions';

function renameForm(name: string): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('sandboxId', 'sb1');
  fd.set('name', name);
  return fd;
}

describe('renameSandboxAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.transaction.mockImplementation(async (ops: unknown[]) => ops);
  });

  it('does not rename a sandbox outside the workspace', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(null);

    await renameSandboxAction(renameForm('New lab'));

    expect(mocks.sandboxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sb1', workspaceId: 'ws1' } }),
    );
    expect(mocks.sandboxUpdate).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
  });

  it('renames the sandbox and its backing deployment', async () => {
    mocks.sandboxFindFirst.mockResolvedValue({ id: 'sb1', deploymentId: 'dep1' });

    await renameSandboxAction(renameForm('  Renamed lab  '));

    expect(mocks.sandboxUpdate).toHaveBeenCalledWith({
      where: { id: 'sb1' },
      data: { name: 'Renamed lab' },
    });
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: { name: 'Sandbox: Renamed lab' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/sandboxes');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/sandboxes/sb1');
  });
});
