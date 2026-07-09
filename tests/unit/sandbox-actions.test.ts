import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  sandboxFindFirst: vi.fn(),
  sandboxUpdate: vi.fn(),
  deploymentUpdate: vi.fn(),
  transaction: vi.fn(),
  effectiveStatus: vi.fn(),
  killProcess: vi.fn(),
  startProcess: vi.fn(),
  restartProcess: vi.fn(),
  removeDockerSandboxContainer: vi.fn(),
  resolveSpawnSpec: vi.fn(),
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
  effectiveStatus: mocks.effectiveStatus,
  startProcess: mocks.startProcess,
  stopProcess: vi.fn(),
  restartProcess: mocks.restartProcess,
  killProcess: mocks.killProcess,
}));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('@/lib/sandboxes/runtime', () => ({
  DEFAULT_SANDBOX_IMAGE: 'node:24-bookworm-slim',
  removeDockerSandboxContainer: mocks.removeDockerSandboxContainer,
  removeDockerSandboxRuntime: vi.fn(),
  sandboxVolumeName: (id: string) => `toolplane-sandbox-${id}`,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { renameSandboxAction, startSandboxAction, updateSandboxEnvAction } from '@/lib/sandboxes/actions';

function renameForm(name: string): FormData {
  const fd = new FormData();
  fd.set('workspace', 'mine');
  fd.set('sandboxId', 'sb1');
  fd.set('name', name);
  return fd;
}

function envForm(env: string): FormData {
  const fd = renameForm('Ignored');
  fd.set('env', env);
  return fd;
}

describe('renameSandboxAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.transaction.mockImplementation(async (ops: unknown[]) => ops);
    mocks.effectiveStatus.mockReturnValue('stopped');
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

  it('starts sandboxes in provisioning mode without waiting for ready', async () => {
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sb1',
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      kind: 'docker',
      deployment: { id: 'dep1' },
    });
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox' });

    await startSandboxAction(renameForm('Ignored'));

    expect(mocks.resolveSpawnSpec).toHaveBeenCalledWith({ id: 'dep1' });
    expect(mocks.startProcess).toHaveBeenCalledWith('dep1', { kind: 'sandbox' }, { awaitReady: false });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/sandboxes');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/sandboxes/sb1');
  });

  it('updates docker sandbox env and recreates a running container without removing the volume', async () => {
    const updatedDeployment = { id: 'dep1', installCfg: { env: { A: '1' } } };
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sb1',
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      kind: 'docker',
      image: 'node:24-bookworm-slim',
      network: 'isolated',
      config: null,
      deployment: { id: 'dep1', status: 'running' },
    });
    mocks.deploymentUpdate.mockResolvedValue(updatedDeployment);
    mocks.transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
    mocks.effectiveStatus.mockReturnValue('running');
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox', env: { A: '1' } });

    await updateSandboxEnvAction(envForm('A=1'));

    expect(mocks.sandboxUpdate).toHaveBeenCalledWith({
      where: { id: 'sb1' },
      data: { config: { env: { A: '1' } } },
    });
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep1' },
      data: {
        installCfg: expect.objectContaining({
          env: { A: '1' },
          volumeName: 'toolplane-sandbox-sb1',
        }),
      },
    });
    expect(mocks.killProcess).toHaveBeenCalledWith('dep1');
    expect(mocks.removeDockerSandboxContainer).toHaveBeenCalledWith('sb1');
    expect(mocks.startProcess).toHaveBeenCalledWith('dep1', { kind: 'sandbox', env: { A: '1' } }, { awaitReady: false });
  });
});
