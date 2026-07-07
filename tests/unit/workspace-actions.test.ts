import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentDeleteMany: vi.fn(),
  userFindUnique: vi.fn(),
  membershipFindUnique: vi.fn(),
  membershipCreate: vi.fn(),
  startProcess: vi.fn(),
  resolveSpawnSpec: vi.fn(),
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
    user: {
      findUnique: mocks.userFindUnique,
    },
    membership: {
      findUnique: mocks.membershipFindUnique,
      create: mocks.membershipCreate,
    },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  startProcess: mocks.startProcess,
  stopProcess: vi.fn(),
  restartProcess: vi.fn(),
  killProcess: mocks.killProcess,
}));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('@/lib/workspace/teardown', () => ({ killWorkspaceProcesses: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import {
  inviteWorkspaceMemberAction,
  removeDeploymentAction,
  startDeploymentAction,
} from '@/lib/workspace/actions';

function formData(deploymentId: string): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('deploymentId', deploymentId);
  return fd;
}

function inviteFormData(email: string): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('email', email);
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

  it('starts deployments in provisioning mode without waiting for ready', async () => {
    mocks.deploymentFindFirst.mockResolvedValue({ id: 'dep1', workspaceId: 'ws1' });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'builtin' });

    await startDeploymentAction(formData('dep1'));

    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith({ id: 'dep1', workspaceId: 'ws1' });
    expect(mocks.startProcess).toHaveBeenCalledWith('dep1', { kind: 'builtin' }, { awaitReady: false });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/mcp/dep1');
  });
});

describe('inviteWorkspaceMemberAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'owner1' });
  });

  it('adds an existing user to the current workspace as a member', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user2', email: 'teammate@example.com' });
    mocks.membershipFindUnique.mockResolvedValue(null);

    const result = await inviteWorkspaceMemberAction({}, inviteFormData('Teammate@Example.com'));

    expect(result.error).toBeUndefined();
    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { email: 'teammate@example.com' },
      select: { id: true, email: true },
    });
    expect(mocks.membershipCreate).toHaveBeenCalledWith({
      data: { workspaceId: 'ws1', userId: 'user2', role: 'member' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/members');
  });

  it('requires the current user to own the workspace', async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'owner2' });

    const result = await inviteWorkspaceMemberAction({}, inviteFormData('teammate@example.com'));

    expect(result.error).toBe('Only the workspace owner can invite members.');
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.membershipCreate).not.toHaveBeenCalled();
  });

  it('does not create a duplicate membership', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'user2', email: 'teammate@example.com' });
    mocks.membershipFindUnique.mockResolvedValue({ id: 'membership1' });

    const result = await inviteWorkspaceMemberAction({}, inviteFormData('teammate@example.com'));

    expect(result.message).toBe('teammate@example.com is already a member.');
    expect(mocks.membershipCreate).not.toHaveBeenCalled();
  });
});
