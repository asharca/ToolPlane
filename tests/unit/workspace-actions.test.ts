import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentDeleteMany: vi.fn(),
  killProcess: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    deployment: {
      findFirst: mocks.deploymentFindFirst,
      deleteMany: mocks.deploymentDeleteMany,
    },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  restartProcess: vi.fn(),
  killProcess: mocks.killProcess,
}));
vi.mock('@/lib/workspace/teardown', () => ({ killWorkspaceProcesses: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { removeDeploymentAction } from '@/lib/workspace/actions';

function formData(deploymentId: string): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('deploymentId', deploymentId);
  return fd;
}

describe('removeDeploymentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
  });

  it('does not kill a process when the deployment is outside the workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue(null);

    await removeDeploymentAction(formData('foreign-dep'));

    expect(mocks.deploymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'foreign-dep', workspaceId: 'ws1' } }),
    );
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.deploymentDeleteMany).not.toHaveBeenCalled();
  });

  it('kills only after the deployment is confirmed in the workspace', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1' });

    await removeDeploymentAction(formData('dep1'));

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1');
    expect(mocks.deploymentDeleteMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1' },
    });
  });
});
