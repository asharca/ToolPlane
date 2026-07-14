import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deploymentFindMany: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  sandboxFindMany: vi.fn(),
  killMany: vi.fn(),
  preventWorkspaceStarts: vi.fn(),
  removeDockerSandboxRuntimeStrict: vi.fn(),
  removeDockerVolumeStrict: vi.fn(),
  disconnectConnector: vi.fn(),
  closeWorkspaceOperations: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    deployment: {
      findMany: mocks.deploymentFindMany,
      updateMany: mocks.deploymentUpdateMany,
    },
    sandbox: { findMany: mocks.sandboxFindMany },
  },
}));
vi.mock('@/lib/process/supervisor', () => ({
  killMany: mocks.killMany,
  preventWorkspaceStarts: mocks.preventWorkspaceStarts,
}));
vi.mock('@/lib/sandboxes/runtime', () => ({
  removeDockerSandboxRuntimeStrict: mocks.removeDockerSandboxRuntimeStrict,
  removeDockerVolumeStrict: mocks.removeDockerVolumeStrict,
}));
vi.mock('@/lib/sandboxes/connector-broker', () => ({
  disconnectConnector: mocks.disconnectConnector,
}));
vi.mock('@/lib/workspace/operation-gate', () => ({
  closeWorkspaceOperations: mocks.closeWorkspaceOperations,
}));

import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

describe('workspace process teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.killMany.mockResolvedValue(undefined);
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 2 });
    mocks.removeDockerSandboxRuntimeStrict.mockResolvedValue(undefined);
    mocks.removeDockerVolumeStrict.mockResolvedValue(undefined);
    mocks.closeWorkspaceOperations.mockResolvedValue(undefined);
  });

  it('disconnects connectors and strictly removes snapshots before the Docker runtime', async () => {
    mocks.deploymentFindMany.mockResolvedValue([{ id: 'dep-connector' }, { id: 'dep-docker' }]);
    mocks.sandboxFindMany.mockResolvedValue([
      {
        id: 'sb-connector',
        kind: 'connector',
        deploymentId: 'dep-connector',
        deployment: { installCfg: {} },
        snapshots: [],
      },
      {
        id: 'sb-docker',
        kind: 'docker',
        deploymentId: 'dep-docker',
        deployment: { installCfg: { volumeName: 'vol-docker' } },
        snapshots: [{ volumeName: 'vol-snapshot-1' }, { volumeName: 'vol-snapshot-2' }],
      },
    ]);

    await killWorkspaceProcesses('ws1');

    expect(mocks.preventWorkspaceStarts).toHaveBeenCalledWith('ws1');
    expect(mocks.preventWorkspaceStarts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeWorkspaceOperations.mock.invocationCallOrder[0],
    );
    expect(mocks.closeWorkspaceOperations).toHaveBeenCalledWith('ws1');
    expect(mocks.closeWorkspaceOperations.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentFindMany.mock.invocationCallOrder[0],
    );
    expect(mocks.disconnectConnector).toHaveBeenCalledWith('sb-connector', 'workspace deleted');
    expect(mocks.killMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentUpdateMany.mock.invocationCallOrder[0],
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws1',
        OR: [
          { source: null },
          { source: { not: 'sandbox' } },
        ],
      },
      data: { status: 'stopped' },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws1', source: 'sandbox' },
      data: { status: 'deleting' },
    });
    expect(mocks.deploymentUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disconnectConnector.mock.invocationCallOrder[0],
    );
    expect(mocks.killMany).toHaveBeenCalledWith(
      ['dep-connector', 'dep-docker'],
      { finalStatus: 'deleting' },
    );
    expect(mocks.sandboxFindMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws1' },
      include: {
        deployment: { select: { installCfg: true } },
        snapshots: { select: { volumeName: true } },
      },
    });
    expect(mocks.removeDockerVolumeStrict.mock.calls).toEqual([
      ['vol-snapshot-1'],
      ['vol-snapshot-2'],
    ]);
    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith('sb-docker', 'vol-docker');
    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalledWith(
      'sb-connector',
      expect.anything(),
    );
    expect(mocks.disconnectConnector.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeDockerVolumeStrict.mock.invocationCallOrder[0],
    );
    expect(mocks.removeDockerVolumeStrict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeDockerVolumeStrict.mock.invocationCallOrder[1],
    );
    expect(mocks.removeDockerVolumeStrict.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.removeDockerSandboxRuntimeStrict.mock.invocationCallOrder[0],
    );
  });

  it('propagates strict snapshot cleanup failures before removing the main runtime', async () => {
    const cleanupError = new Error('snapshot volume is still in use');
    mocks.deploymentFindMany.mockResolvedValue([{ id: 'dep-docker' }]);
    mocks.sandboxFindMany.mockResolvedValue([
      {
        id: 'sb-docker',
        kind: 'docker',
        deploymentId: 'dep-docker',
        deployment: { installCfg: { volumeName: 'vol-docker' } },
        snapshots: [{ volumeName: 'vol-snapshot' }],
      },
    ]);
    mocks.removeDockerVolumeStrict.mockRejectedValueOnce(cleanupError);

    await expect(killWorkspaceProcesses('ws1')).rejects.toBe(cleanupError);

    expect(mocks.removeDockerVolumeStrict).toHaveBeenCalledWith('vol-snapshot');
    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalled();
  });

  it('keeps regular deployments stopped while sandboxes remain deleting', async () => {
    mocks.deploymentFindMany.mockResolvedValue([{ id: 'dep-regular' }, { id: 'dep-sandbox' }]);
    mocks.sandboxFindMany.mockResolvedValue([{
      id: 'sb-docker',
      kind: 'docker',
      deploymentId: 'dep-sandbox',
      deployment: { installCfg: { volumeName: 'vol-docker' } },
      snapshots: [],
    }]);

    await killWorkspaceProcesses('ws1');

    expect(mocks.killMany.mock.calls).toEqual([
      [['dep-regular']],
      [['dep-sandbox'], { finalStatus: 'deleting' }],
    ]);
  });
});
