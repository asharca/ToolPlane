import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  sandboxFindFirst: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxUpdate: vi.fn(),
  sandboxSnapshotFindFirst: vi.fn(),
  sandboxSnapshotCreate: vi.fn(),
  sandboxSnapshotUpdate: vi.fn(),
  sandboxSnapshotUpdateMany: vi.fn(),
  sandboxSnapshotDeleteMany: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentDeleteMany: vi.fn(),
  deploymentUpdate: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  transaction: vi.fn(),
  allowProcessRestart: vi.fn(),
  effectiveStatus: vi.fn(),
  killProcess: vi.fn(),
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  restartProcess: vi.fn(),
  copyDockerVolume: vi.fn(),
  removeDockerSandboxContainer: vi.fn(),
  removeDockerSandboxRuntimeStrict: vi.fn(),
  removeDockerVolumeCopyHelper: vi.fn(),
  removeDockerVolumeStrict: vi.fn(),
  stopDockerSandboxContainer: vi.fn(),
  DockerVolumeCopyCleanupError: class DockerVolumeCopyCleanupError extends AggregateError {
    helperName?: string;

    constructor(errors: unknown[], message: string, helperName?: string) {
      super(errors, message);
      this.helperName = helperName;
    }
  },
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
    sandboxSnapshot: {
      findFirst: mocks.sandboxSnapshotFindFirst,
      create: mocks.sandboxSnapshotCreate,
      update: mocks.sandboxSnapshotUpdate,
      updateMany: mocks.sandboxSnapshotUpdateMany,
      deleteMany: mocks.sandboxSnapshotDeleteMany,
    },
    deployment: {
      create: mocks.deploymentCreate,
      deleteMany: mocks.deploymentDeleteMany,
      update: mocks.deploymentUpdate,
      updateMany: mocks.deploymentUpdateMany,
    },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  allowProcessRestart: mocks.allowProcessRestart,
  effectiveStatus: mocks.effectiveStatus,
  startProcess: mocks.startProcess,
  stopProcess: mocks.stopProcess,
  restartProcess: mocks.restartProcess,
  killProcess: mocks.killProcess,
}));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('@/lib/sandboxes/runtime', () => ({
  DEFAULT_SANDBOX_IMAGE: 'node:24-bookworm-slim',
  copyDockerVolume: mocks.copyDockerVolume,
  DockerVolumeCopyCleanupError: mocks.DockerVolumeCopyCleanupError,
  removeDockerSandboxContainer: mocks.removeDockerSandboxContainer,
  removeDockerSandboxRuntimeStrict: mocks.removeDockerSandboxRuntimeStrict,
  removeDockerVolumeCopyHelper: mocks.removeDockerVolumeCopyHelper,
  removeDockerVolumeStrict: mocks.removeDockerVolumeStrict,
  sandboxSnapshotVolumeName: (id: string) => `toolplane-snapshot-${id}`,
  sandboxVolumeName: (id: string) => `toolplane-sandbox-${id}`,
  stopDockerSandboxContainer: mocks.stopDockerSandboxContainer,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@/lib/sandboxes/connector-broker', () => ({ disconnectConnector: mocks.disconnectConnector }));
vi.mock('@/lib/sandboxes/connector-setup-token', () => ({
  setConnectorSetupTokenCookie: mocks.setConnectorSetupTokenCookie,
}));

import {
  cloneSandboxAction,
  createSandboxAction,
  createSandboxSnapshotAction,
  deleteSandboxSnapshotAction,
  deleteSandboxAction,
  generateConnectorCommandAction,
  renameSandboxAction,
  restoreSandboxSnapshotAction,
  restartSandboxAction,
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

function snapshotForm(snapshotId = 'snap1'): FormData {
  const fd = renameForm('Ignored');
  fd.set('snapshotId', snapshotId);
  return fd;
}

function dockerSandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sb1',
    workspaceId: 'ws1',
    deploymentId: 'dep1',
    name: 'Source lab',
    kind: 'docker',
    image: 'node:24-bookworm-slim',
    network: 'isolated',
    config: { env: { A: '1' } },
    snapshots: [],
    deployment: {
      id: 'dep1',
      status: 'stopped',
      installCfg: { volumeName: 'source-volume' },
    },
    ...overrides,
  };
}

describe('renameSandboxAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user1' });
    mocks.getWorkspaceForUser.mockResolvedValue({ id: 'ws1', ownerId: 'user1' });
    mocks.transaction.mockImplementation(async (ops: unknown[]) => ops);
    mocks.effectiveStatus.mockReturnValue('stopped');
    mocks.killProcess.mockResolvedValue(undefined);
    mocks.removeDockerVolumeCopyHelper.mockResolvedValue(undefined);
    mocks.headers.mockResolvedValue(new Headers({
      'x-forwarded-host': 'connect.example.com',
      'x-forwarded-proto': 'https',
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { name: 'clone', action: cloneSandboxAction, form: () => renameForm('Copy') },
    { name: 'create snapshot', action: createSandboxSnapshotAction, form: () => renameForm('Checkpoint') },
    { name: 'restore snapshot', action: restoreSandboxSnapshotAction, form: () => snapshotForm() },
    { name: 'delete snapshot', action: deleteSandboxSnapshotAction, form: () => snapshotForm() },
  ])('scopes $name source lookup to the authorized workspace', async ({ action, form }) => {
    mocks.sandboxFindFirst.mockResolvedValue(null);

    await action(form());

    expect(mocks.sandboxFindFirst).toHaveBeenCalledWith({
      where: { id: 'sb1', workspaceId: 'ws1' },
      include: { deployment: true, snapshots: true },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.sandboxSnapshotFindFirst).not.toHaveBeenCalled();
    expect(mocks.sandboxSnapshotCreate).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();
    expect(mocks.removeDockerVolumeStrict).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'clone', action: cloneSandboxAction, form: () => renameForm('Copy') },
    { name: 'create snapshot', action: createSandboxSnapshotAction, form: () => renameForm('Checkpoint') },
    { name: 'restore snapshot', action: restoreSandboxSnapshotAction, form: () => snapshotForm() },
  ])('does not $name while sandbox data is in an interrupted copy state', async ({ action, form }) => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      deployment: { id: 'dep1', status: 'copy_failed', installCfg: { volumeName: 'source-volume' } },
    }));
    mocks.effectiveStatus.mockReturnValue('copy_failed');

    await action(form());

    expect(mocks.sandboxSnapshotFindFirst).not.toHaveBeenCalled();
    expect(mocks.sandboxSnapshotCreate).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'start', action: startSandboxAction, form: () => renameForm('Ignored') },
    { name: 'stop', action: stopSandboxAction, form: () => renameForm('Ignored') },
    { name: 'restart', action: restartSandboxAction, form: () => renameForm('Ignored') },
    { name: 'update environment', action: updateSandboxEnvAction, form: () => envForm('A=1') },
  ])('does not $name an interrupted clone', async ({ action, form }) => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      deployment: { id: 'dep1', status: 'copy_failed', installCfg: { volumeName: 'source-volume' } },
    }));

    await action(form());

    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.stopProcess).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
    expect(mocks.sandboxUpdate).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdate).not.toHaveBeenCalled();
  });

  it.each(['copy_failed', 'restore_failed', 'deleting'])(
    'does not manually start a sandbox in %s state',
    async (status) => {
      mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
        deployment: { id: 'dep1', status, installCfg: { volumeName: 'source-volume' } },
      }));

      await startSandboxAction(renameForm('Ignored'));

      expect(mocks.startProcess).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'clone', action: cloneSandboxAction, form: () => renameForm('Copy') },
    { name: 'create snapshot', action: createSandboxSnapshotAction, form: () => renameForm('Checkpoint') },
    { name: 'restore snapshot', action: restoreSandboxSnapshotAction, form: () => snapshotForm() },
    { name: 'delete snapshot', action: deleteSandboxSnapshotAction, form: () => snapshotForm() },
  ])('rejects $name for connector sandboxes', async ({ action, form }) => {
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sb1',
      workspaceId: 'ws1',
      deploymentId: 'dep1',
      name: 'Laptop',
      kind: 'connector',
      image: null,
      network: 'isolated',
      config: {},
      snapshots: [],
      deployment: { id: 'dep1', status: 'stopped', installCfg: {} },
    });

    await action(form());

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.sandboxSnapshotFindFirst).not.toHaveBeenCalled();
    expect(mocks.sandboxSnapshotCreate).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();
    expect(mocks.removeDockerVolumeStrict).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'restore',
      action: restoreSandboxSnapshotAction,
      expectedWhere: { id: 'snap1', sandboxId: 'sb1', status: 'ready' },
    },
    {
      name: 'delete',
      action: deleteSandboxSnapshotAction,
      expectedWhere: { id: 'snap1', sandboxId: 'sb1' },
    },
  ])('does not $name a snapshot owned by another sandbox', async ({ action, expectedWhere }) => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox());
    mocks.sandboxSnapshotFindFirst.mockResolvedValue(null);

    await action(snapshotForm());

    expect(mocks.sandboxSnapshotFindFirst).toHaveBeenCalledWith({ where: expectedWhere });
    expect(mocks.sandboxSnapshotUpdate).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();
    expect(mocks.removeDockerVolumeStrict).not.toHaveBeenCalled();
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
    mocks.sandboxFindFirst.mockResolvedValue({
      id: 'sb1',
      deploymentId: 'dep1',
      deployment: { id: 'dep1', status: 'stopped' },
    });

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

  it('clones a Docker sandbox volume while quiesced and starts the clone', async () => {
    const source = dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'running',
        installCfg: { volumeName: 'source-volume' },
      },
    });
    mocks.sandboxFindFirst.mockResolvedValueOnce(source).mockResolvedValueOnce(null);
    mocks.deploymentCreate.mockResolvedValue({ id: 'dep2' });
    mocks.sandboxCreate.mockImplementation(async ({ data }) => ({ ...data, id: 'sb2' }));
    mocks.deploymentUpdate.mockResolvedValue({
      id: 'dep2',
      status: 'stopped',
      installCfg: { volumeName: 'toolplane-sandbox-sb2' },
    });
    mocks.transaction.mockImplementation(async (callback) => callback({
      deployment: {
        create: mocks.deploymentCreate,
        update: mocks.deploymentUpdate,
      },
      sandbox: { create: mocks.sandboxCreate },
    }));
    mocks.effectiveStatus.mockReturnValue('running');
    mocks.resolveSpawnSpec.mockImplementation((deployment) => ({ deploymentId: deployment.id }));

    await cloneSandboxAction(renameForm('  Copied lab  '));

    expect(mocks.sandboxFindFirst).toHaveBeenNthCalledWith(2, {
      where: { workspaceId: 'ws1', slug: 'copied-lab' },
    });
    expect(mocks.deploymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws1',
        name: 'Sandbox: Copied lab',
        source: 'sandbox',
        sourceRef: 'node:24-bookworm-slim',
        status: 'copying',
      }),
    });
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws1',
        deploymentId: 'dep2',
        name: 'Copied lab',
        slug: 'copied-lab',
        kind: 'docker',
        config: { env: { A: '1' } },
      }),
    });
    expect(mocks.killProcess).toHaveBeenCalledWith('dep1');
    expect(mocks.stopDockerSandboxContainer).toHaveBeenCalledWith('sb1');
    expect(mocks.copyDockerVolume).toHaveBeenCalledWith(
      'source-volume',
      'toolplane-sandbox-sb2',
    );
    expect(mocks.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: 'dep2' },
      data: { status: 'provisioning' },
    });
    expect(mocks.startProcess).toHaveBeenNthCalledWith(
      1,
      'dep2',
      { deploymentId: 'dep2' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
    expect(mocks.startProcess).toHaveBeenNthCalledWith(
      2,
      'dep1',
      { deploymentId: 'dep1' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/sandboxes/sb2');
  });

  it('keeps the completed clone when only the source sandbox fails to resume', async () => {
    const source = dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'running',
        installCfg: { volumeName: 'source-volume' },
      },
    });
    mocks.sandboxFindFirst.mockResolvedValueOnce(source).mockResolvedValueOnce(null);
    mocks.deploymentCreate.mockResolvedValue({ id: 'dep2' });
    mocks.sandboxCreate.mockImplementation(async ({ data }) => ({ ...data, id: 'sb2' }));
    mocks.deploymentUpdate.mockResolvedValue({ id: 'dep2', status: 'provisioning', installCfg: {} });
    mocks.transaction.mockImplementation(async (callback) => callback({
      deployment: { create: mocks.deploymentCreate, update: mocks.deploymentUpdate },
      sandbox: { create: mocks.sandboxCreate },
    }));
    mocks.effectiveStatus.mockReturnValue('running');
    mocks.resolveSpawnSpec.mockImplementation((deployment) => ({ deploymentId: deployment.id }));
    mocks.startProcess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('source resume failed'));

    await cloneSandboxAction(renameForm('Copied lab'));

    expect(mocks.startProcess).toHaveBeenCalledTimes(2);
    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalled();
    expect(mocks.deploymentDeleteMany).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/sandboxes/sb2');
  });

  it('keeps an incompletely cleaned clone in a non-runnable copy-failed state', async () => {
    const source = dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'running',
        installCfg: { volumeName: 'source-volume' },
      },
    });
    mocks.sandboxFindFirst.mockResolvedValueOnce(source).mockResolvedValueOnce(null);
    mocks.deploymentCreate.mockResolvedValue({ id: 'dep2' });
    mocks.sandboxCreate.mockImplementation(async ({ data }) => ({ ...data, id: 'sb2' }));
    mocks.deploymentUpdate.mockResolvedValue({ id: 'dep2', status: 'copying', installCfg: {} });
    mocks.transaction.mockImplementation(async (callback) => callback({
      deployment: { create: mocks.deploymentCreate, update: mocks.deploymentUpdate },
      sandbox: { create: mocks.sandboxCreate },
    }));
    mocks.effectiveStatus.mockReturnValue('running');
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox' });
    const copyError = new Error('copy failed');
    mocks.copyDockerVolume.mockRejectedValueOnce(copyError);
    mocks.removeDockerSandboxRuntimeStrict.mockRejectedValueOnce(new Error('volume still busy'));

    await expect(cloneSandboxAction(renameForm('Copied lab'))).rejects.toBe(copyError);

    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dep2', workspaceId: 'ws1' },
      data: { status: 'copy_failed' },
    });
    expect(mocks.killProcess).toHaveBeenCalledWith('dep2', {
      preventRestart: true,
      finalStatus: 'copy_failed',
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
  });

  it('creates a snapshot from a quiesced Docker volume and marks it ready', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'running',
        installCfg: { volumeName: 'source-volume' },
      },
    }));
    mocks.sandboxSnapshotCreate.mockImplementation(async ({ data }) => data);
    mocks.effectiveStatus.mockReturnValue('running');
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox' });
    const form = renameForm('  Before upgrade  ');

    await createSandboxSnapshotAction(form);

    const snapshotData = mocks.sandboxSnapshotCreate.mock.calls[0][0].data;
    expect(snapshotData).toEqual({
      id: expect.any(String),
      sandboxId: 'sb1',
      name: 'Before upgrade',
      volumeName: expect.stringMatching(/^toolplane-snapshot-/),
      status: 'creating',
    });
    expect(mocks.killProcess).toHaveBeenCalledWith('dep1');
    expect(mocks.stopDockerSandboxContainer).toHaveBeenCalledWith('sb1');
    expect(mocks.copyDockerVolume).toHaveBeenCalledWith('source-volume', snapshotData.volumeName);
    expect(mocks.sandboxSnapshotUpdate).toHaveBeenCalledWith({
      where: { id: snapshotData.id },
      data: { status: 'ready', error: null },
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'dep1',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'ws1' },
    );
  });

  it('restores a ready snapshot and removes the rollback volume', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox());
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      volumeName: 'snapshot-volume',
      status: 'ready',
    });

    await restoreSandboxSnapshotAction(snapshotForm());

    expect(mocks.sandboxSnapshotFindFirst).toHaveBeenCalledWith({
      where: { id: 'snap1', sandboxId: 'sb1', status: 'ready' },
    });
    const rollbackVolume = mocks.copyDockerVolume.mock.calls[0][1];
    expect(rollbackVolume).toMatch(/^toolplane-snapshot-restore-/);
    expect(mocks.copyDockerVolume).toHaveBeenNthCalledWith(1, 'source-volume', rollbackVolume);
    expect(mocks.copyDockerVolume).toHaveBeenNthCalledWith(
      2,
      'snapshot-volume',
      'source-volume',
      { replace: true },
    );
    expect(mocks.sandboxSnapshotCreate).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^restore-/),
        sandboxId: 'sb1',
        name: 'Restore recovery: Snapshot',
        volumeName: rollbackVolume,
        status: 'creating',
      },
    });
    expect(mocks.sandboxSnapshotUpdateMany).toHaveBeenCalledWith({
      where: {
        id: expect.stringMatching(/^restore-/),
        sandboxId: 'sb1',
      },
      data: { status: 'ready', error: null },
    });
    expect(mocks.sandboxSnapshotUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.copyDockerVolume.mock.invocationCallOrder[1],
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'restoring' },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.sandboxSnapshotUpdateMany).toHaveBeenCalledWith({
      where: {
        id: expect.stringMatching(/^restore-/),
        sandboxId: 'sb1',
      },
      data: { status: 'deleting', error: null },
    });
    expect(mocks.removeDockerVolumeStrict).toHaveBeenCalledWith(rollbackVolume);
    expect(mocks.sandboxSnapshotDeleteMany).toHaveBeenCalledWith({
      where: {
        id: expect.stringMatching(/^restore-/),
        sandboxId: 'sb1',
      },
    });
    expect(mocks.sandboxSnapshotUpdate).toHaveBeenCalledWith({
      where: { id: 'snap1' },
      data: { error: null },
    });
  });

  it('rolls the Docker volume back when snapshot restoration fails', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox());
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      volumeName: 'snapshot-volume',
      status: 'ready',
    });
    const restoreError = new Error('restore failed');
    mocks.copyDockerVolume
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(restoreError)
      .mockResolvedValueOnce(undefined);

    await expect(restoreSandboxSnapshotAction(snapshotForm())).rejects.toBe(restoreError);

    const rollbackVolume = mocks.copyDockerVolume.mock.calls[0][1];
    expect(mocks.copyDockerVolume).toHaveBeenNthCalledWith(
      3,
      rollbackVolume,
      'source-volume',
      { replace: true },
    );
    expect(mocks.removeDockerVolumeStrict).toHaveBeenCalledWith(rollbackVolume);
    expect(mocks.sandboxSnapshotUpdate).not.toHaveBeenCalled();
  });

  it('allows a recovery snapshot to repair a restore-failed sandbox without auto-starting it', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'restore_failed',
        installCfg: { volumeName: 'source-volume' },
      },
    }));
    mocks.effectiveStatus.mockReturnValue('restore_failed');
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      name: 'Recovery',
      volumeName: 'snapshot-volume',
      status: 'ready',
    });

    await restoreSandboxSnapshotAction(snapshotForm());

    expect(mocks.copyDockerVolume).toHaveBeenNthCalledWith(
      2,
      'snapshot-volume',
      'source-volume',
      { replace: true },
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });

  it('keeps restore-failed durable when the retry backup copy is interrupted', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'restore_failed',
        installCfg: { volumeName: 'source-volume' },
      },
    }));
    mocks.effectiveStatus.mockReturnValue('restore_failed');
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      name: 'Recovery',
      volumeName: 'snapshot-volume',
      status: 'ready',
    });
    const backupError = new Error('backup interrupted');
    mocks.copyDockerVolume.mockRejectedValueOnce(backupError);

    await expect(restoreSandboxSnapshotAction(snapshotForm())).rejects.toBe(backupError);

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', { finalStatus: 'restore_failed' });
    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'restoring' } }),
    );
    expect(mocks.startProcess).not.toHaveBeenCalled();
  });

  it('keeps a recovery snapshot and leaves the sandbox stopped when restore and rollback both fail', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'running',
        installCfg: { volumeName: 'source-volume' },
      },
    }));
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      name: 'Before upgrade',
      volumeName: 'snapshot-volume',
      status: 'ready',
    });
    mocks.sandboxSnapshotCreate.mockImplementation(async ({ data }) => data);
    mocks.effectiveStatus.mockReturnValue('running');
    const restoreError = new Error('restore failed');
    const rollbackError = new Error('rollback failed');
    mocks.copyDockerVolume
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(restoreError)
      .mockRejectedValueOnce(rollbackError);

    await expect(restoreSandboxSnapshotAction(snapshotForm())).rejects.toThrow(
      'Snapshot restore and automatic rollback both failed.',
    );

    const rollbackVolume = mocks.copyDockerVolume.mock.calls[0][1];
    expect(mocks.removeDockerVolumeStrict).not.toHaveBeenCalled();
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'restore_failed' },
    });
    expect(mocks.sandboxSnapshotCreate).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^restore-/),
        sandboxId: 'sb1',
        name: 'Restore recovery: Before upgrade',
        volumeName: rollbackVolume,
        status: 'creating',
      },
    });
    expect(mocks.sandboxSnapshotUpdateMany).toHaveBeenCalledWith({
      where: {
        id: expect.stringMatching(/^restore-/),
        sandboxId: 'sb1',
      },
      data: { status: 'ready', error: null },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/mine/sandboxes/sb1');
  });

  it('does not start rollback or resume when a restore helper cannot be removed', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      deployment: {
        id: 'dep1',
        status: 'running',
        installCfg: { volumeName: 'source-volume' },
      },
    }));
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      name: 'Before upgrade',
      volumeName: 'snapshot-volume',
      status: 'ready',
    });
    mocks.sandboxSnapshotCreate.mockImplementation(async ({ data }) => data);
    mocks.effectiveStatus.mockReturnValue('running');
    vi.useFakeTimers();
    const unsafeError = new mocks.DockerVolumeCopyCleanupError(
      [new Error('copy timeout'), new Error('cleanup timeout')],
      'helper cleanup failed',
      'toolplane-volume-copy-restore',
    );
    mocks.copyDockerVolume
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(unsafeError);

    await expect(restoreSandboxSnapshotAction(snapshotForm())).rejects.toBe(unsafeError);

    expect(mocks.copyDockerVolume).toHaveBeenCalledTimes(2);
    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.removeDockerVolumeStrict).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'restore_cleanup_required' },
    });
    expect(mocks.sandboxSnapshotCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sandboxId: 'sb1',
        name: 'Restore recovery: Before upgrade',
        status: 'creating',
      }),
    });
    expect(mocks.sandboxSnapshotUpdateMany).toHaveBeenCalledWith({
      where: {
        id: expect.stringMatching(/^restore-/),
        sandboxId: 'sb1',
      },
      data: { status: 'ready', error: null },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.removeDockerVolumeCopyHelper).toHaveBeenCalledWith(
      'toolplane-volume-copy-restore',
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'dep1',
        workspaceId: 'ws1',
        source: 'sandbox',
        status: { in: ['restoring', 'restore_cleanup_required'] },
      },
      data: { status: 'restore_failed' },
    });
  });

  it('deletes the snapshot volume before deleting its database record', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox());
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      volumeName: 'snapshot-volume',
      status: 'ready',
    });

    await deleteSandboxSnapshotAction(snapshotForm());

    expect(mocks.sandboxSnapshotUpdate).toHaveBeenCalledWith({
      where: { id: 'snap1' },
      data: { status: 'deleting', error: null },
    });
    expect(mocks.removeDockerVolumeStrict).toHaveBeenCalledWith('snapshot-volume');
    expect(mocks.sandboxSnapshotDeleteMany).toHaveBeenCalledWith({
      where: { id: 'snap1', sandboxId: 'sb1' },
    });
    expect(mocks.removeDockerVolumeStrict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sandboxSnapshotDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it('marks snapshot deletion as retryable when the database delete fails', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox());
    mocks.sandboxSnapshotFindFirst.mockResolvedValue({
      id: 'snap1',
      sandboxId: 'sb1',
      volumeName: 'snapshot-volume',
      status: 'deleting',
    });
    const deleteError = new Error('database unavailable');
    mocks.sandboxSnapshotDeleteMany.mockRejectedValue(deleteError);

    await expect(deleteSandboxSnapshotAction(snapshotForm())).rejects.toBe(deleteError);

    expect(mocks.removeDockerVolumeStrict).toHaveBeenCalledWith('snapshot-volume');
    expect(mocks.sandboxSnapshotUpdateMany).toHaveBeenCalledWith({
      where: { id: 'snap1', sandboxId: 'sb1' },
      data: { status: 'error', error: 'Snapshot deletion failed.' },
    });
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

  it('deletes every Docker snapshot volume before removing the sandbox runtime', async () => {
    mocks.sandboxFindFirst.mockResolvedValue(dockerSandbox({
      snapshots: [
        { id: 'snap1', volumeName: 'snapshot-volume-1' },
        { id: 'snap2', volumeName: 'snapshot-volume-2' },
      ],
    }));

    await deleteSandboxAction(renameForm('Ignored'));

    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', {
      preventRestart: true,
      finalStatus: 'deleting',
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'deleting' },
    });
    expect(mocks.removeDockerVolumeStrict).toHaveBeenNthCalledWith(1, 'snapshot-volume-1');
    expect(mocks.removeDockerVolumeStrict).toHaveBeenNthCalledWith(2, 'snapshot-volume-2');
    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith('sb1', 'source-volume');
    expect(mocks.removeDockerVolumeStrict.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.removeDockerSandboxRuntimeStrict.mock.invocationCallOrder[0],
    );
    expect(mocks.deploymentUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeDockerVolumeStrict.mock.invocationCallOrder[0],
    );
    expect(mocks.deploymentDeleteMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
    });
  });

  it('keeps process restart blocked when strict Docker deletion fails', async () => {
    const sandbox = dockerSandbox({
      snapshots: [{ id: 'snap1', volumeName: 'snapshot-volume-1' }],
    });
    mocks.sandboxFindFirst
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce({
        ...sandbox,
        deployment: { ...sandbox.deployment, status: 'deleting' },
      });
    const cleanupError = new Error('volume is busy');
    mocks.removeDockerVolumeStrict.mockRejectedValueOnce(cleanupError);

    await expect(deleteSandboxAction(renameForm('Ignored'))).rejects.toBe(cleanupError);

    expect(mocks.allowProcessRestart).not.toHaveBeenCalled();
    expect(mocks.deploymentDeleteMany).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('retains the deleting state when database deletion fails after Docker cleanup', async () => {
    const sandbox = dockerSandbox();
    mocks.sandboxFindFirst
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce({
        ...sandbox,
        deployment: { ...sandbox.deployment, status: 'deleting' },
      });
    const deleteError = new Error('database unavailable');
    mocks.deploymentDeleteMany.mockRejectedValueOnce(deleteError);

    await expect(deleteSandboxAction(renameForm('Ignored'))).rejects.toBe(deleteError);

    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith('sb1', 'source-volume');
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'deleting' },
    });
    expect(mocks.allowProcessRestart).not.toHaveBeenCalled();
  });

  it('allows restart when deletion is aborted before any external cleanup begins', async () => {
    const sandbox = dockerSandbox();
    mocks.sandboxFindFirst.mockResolvedValue(sandbox);
    const stateError = new Error('database unavailable');
    mocks.deploymentUpdateMany.mockRejectedValueOnce(stateError);

    await expect(deleteSandboxAction(renameForm('Ignored'))).rejects.toBe(stateError);

    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalled();
    expect(mocks.deploymentDeleteMany).not.toHaveBeenCalled();
    expect(mocks.allowProcessRestart).toHaveBeenCalledWith('dep1');
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
    expect(mocks.killProcess).toHaveBeenCalledWith('dep1', {
      preventRestart: true,
      finalStatus: 'deleting',
    });
    expect(mocks.deploymentDeleteMany).toHaveBeenCalledWith({
      where: { id: 'dep1', workspaceId: 'ws1', source: 'sandbox' },
    });
    expect(mocks.redirect).toHaveBeenCalledWith('/app/mine/sandboxes');
    expect(mocks.deploymentDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redirect.mock.invocationCallOrder[0],
    );
  });
});
