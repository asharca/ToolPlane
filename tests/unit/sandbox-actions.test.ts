import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  sandboxFindFirst: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxUpdate: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentDeleteMany: vi.fn(),
  deploymentUpdate: vi.fn(),
  transaction: vi.fn(),
  effectiveStatus: vi.fn(),
  killProcess: vi.fn(),
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  restartProcess: vi.fn(),
  removeDockerSandboxContainer: vi.fn(),
  resolveSpawnSpec: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  disconnectConnector: vi.fn(),
  setConnectorSetupTokenCookie: vi.fn(),
  headers: vi.fn(),
}));

vi.mock('@/lib/auth/current-user', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/workspace/queries', () => ({ getWorkspaceForUser: mocks.getWorkspaceForUser }));
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    sandbox: {
      findFirst: mocks.sandboxFindFirst,
      create: mocks.sandboxCreate,
      update: mocks.sandboxUpdate,
    },
    deployment: {
      create: mocks.deploymentCreate,
      deleteMany: mocks.deploymentDeleteMany,
      update: mocks.deploymentUpdate,
    },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  effectiveStatus: mocks.effectiveStatus,
  startProcess: mocks.startProcess,
  stopProcess: mocks.stopProcess,
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
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@/lib/sandboxes/connector-broker', () => ({ disconnectConnector: mocks.disconnectConnector }));
vi.mock('@/lib/sandboxes/connector-setup-token', () => ({
  setConnectorSetupTokenCookie: mocks.setConnectorSetupTokenCookie,
}));

import {
  createSandboxAction,
  deleteSandboxAction,
  generateConnectorCommandAction,
  renameSandboxAction,
  startSandboxAction,
  stopSandboxAction,
  updateSandboxEnvAction,
} from '@/lib/sandboxes/actions';

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
    mocks.headers.mockResolvedValue(new Headers({
      'x-forwarded-host': 'connect.example.com',
      'x-forwarded-proto': 'https',
    }));
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
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/sandboxes');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/sandboxes/sb1');
  });

  it('creates the connector without collecting connection settings or exposing a token', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(null);
    mocks.deploymentCreate.mockResolvedValue({ id: 'dep1' });
    mocks.sandboxCreate.mockImplementation(async ({ data }) => ({
      ...data,
      id: 'sb1',
      deploymentId: 'dep1',
    }));
    const updatedDeployment = { id: 'dep1', source: 'sandbox', installCfg: {} };
    mocks.deploymentUpdate.mockResolvedValue(updatedDeployment);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox', sandboxKind: 'connector' });
    const form = new FormData();
    form.set('workspace', 'mine');
    form.set('kind', 'connector');
    form.set('name', 'Windows workstation');

    await createSandboxAction(form);

    expect(mocks.deploymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: 'sandbox', status: 'provisioning' }),
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'sandbox', sandboxKind: 'connector' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
    expect(mocks.setConnectorSetupTokenCookie).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/sandboxes/sb1');
  });

  it('rotates a connector token, revokes the active session, and redirects without a token URL', async () => {
    const updatedDeployment = { id: 'dep1', source: 'sandbox', installCfg: {} };
    mocks.deploymentUpdate.mockReturnValue(updatedDeployment);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox', sandboxKind: 'connector' });
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sb1',
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      kind: 'connector',
      config: {
        connector: {
          provider: 'websocket',
          serverUrl: 'https://app.example.com',
          remoteRoot: 'C:\\Users\\Ada\\ToolPlane',
          tokenHash: 'old-hash',
          tokenPrefix: 'mcpcon_old',
          packageName: '/api/v1/connectors/package.tgz',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      },
      deployment: { id: 'dep1', installCfg: {} },
    });

    const form = renameForm('Ignored');
    form.set('connectorServerUrl', 'https://attacker.example.com');
    form.set('connectorRemoteRoot', 'C:\\Users\\Ada Lovelace\\ToolPlane Sandbox');

    await generateConnectorCommandAction(form);

    expect(mocks.disconnectConnector).toHaveBeenCalledWith('sb1', 'connector token rotated');
    expect(mocks.sandboxUpdate).toHaveBeenCalledWith({
      where: { id: 'sb1' },
      data: {
        config: expect.objectContaining({
          connector: expect.objectContaining({
            serverUrl: 'https://connect.example.com',
            remoteRoot: 'C:\\Users\\Ada Lovelace\\ToolPlane Sandbox',
          }),
        }),
      },
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'sandbox', sandboxKind: 'connector' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
    expect(mocks.setConnectorSetupTokenCookie).toHaveBeenCalledWith(
      'mine',
      'sb1',
      expect.stringMatching(/^mcpcon_/),
    );
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/sandboxes/sb1');
    expect(mocks.redirect.mock.calls.flat().join(' ')).not.toContain('token=');
  });

  it('persists a connector stop before disconnecting authenticated sessions', async () => {
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sb1',
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      kind: 'connector',
      deployment: { id: 'dep1', status: 'running' },
    });

    await stopSandboxAction(renameForm('Ignored'));

    expect(mocks.stopProcess).toHaveBeenCalledWith('dep1');
    expect(mocks.disconnectConnector).toHaveBeenCalledWith('sb1', 'sandbox stopped');
    expect(mocks.stopProcess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disconnectConnector.mock.invocationCallOrder[0],
    );
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
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'sandbox', env: { A: '1' } },
      { awaitReady: false, workspaceId: 'ws1' },
    );
  });

  it('redirects to the sandbox list after deleting from a detail page', async () => {
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sb1',
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      kind: 'connector',
      deployment: { id: 'dep1', installCfg: {} },
    });

    await deleteSandboxAction(renameForm('Ignored'));

    expect(mocks.stopProcess).toHaveBeenCalledWith('dep1');
    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', { preventRestart: true });
    expect(mocks.deploymentDeleteMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
    });
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/sandboxes');
    expect(mocks.deploymentDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redirect.mock.invocationCallOrder[0],
    );
  });
});
