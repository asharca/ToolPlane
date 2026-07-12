import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deploymentFindMany: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  sandboxFindMany: vi.fn(),
  killMany: vi.fn(),
  preventWorkspaceStarts: vi.fn(),
  removeDockerSandboxRuntime: vi.fn(),
  disconnectConnector: vi.fn(),
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
  removeDockerSandboxRuntime: mocks.removeDockerSandboxRuntime,
}));
vi.mock('@/lib/sandboxes/connector-broker', () => ({
  disconnectConnector: mocks.disconnectConnector,
}));

import { killWorkspaceProcesses } from '@/lib/workspace/teardown';

describe('workspace process teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.killMany.mockResolvedValue(undefined);
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 2 });
  });

  it('disconnects connector sessions and removes container runtimes before workspace deletion', async () => {
    mocks.deploymentFindMany.mockResolvedValue([{ id: 'dep-connector' }, { id: 'dep-docker' }]);
    mocks.sandboxFindMany.mockResolvedValue([
      { id: 'sb-connector', kind: 'connector', deployment: { installCfg: {} } },
      { id: 'sb-docker', kind: 'docker', deployment: { installCfg: { volumeName: 'vol-docker' } } },
    ]);

    await killWorkspaceProcesses('ws1');

    expect(mocks.preventWorkspaceStarts).toHaveBeenCalledWith('ws1');
    expect(mocks.preventWorkspaceStarts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentFindMany.mock.invocationCallOrder[0],
    );
    expect(mocks.disconnectConnector).toHaveBeenCalledWith('sb-connector', 'workspace deleted');
    expect(mocks.killMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deploymentUpdateMany.mock.invocationCallOrder[0],
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws1' },
      data: { status: 'stopped' },
    });
    expect(mocks.deploymentUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disconnectConnector.mock.invocationCallOrder[0],
    );
    expect(mocks.killMany).toHaveBeenCalledWith(['dep-connector', 'dep-docker']);
    expect(mocks.removeDockerSandboxRuntime).toHaveBeenCalledWith('sb-docker', 'vol-docker');
    expect(mocks.removeDockerSandboxRuntime).not.toHaveBeenCalledWith('sb-connector', expect.anything());
  });
});
