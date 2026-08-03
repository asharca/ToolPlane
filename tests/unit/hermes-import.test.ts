import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentRuntimeFindFirst: vi.fn(),
  agentRuntimeUpdateMany: vi.fn(),
  sandboxUpdateMany: vi.fn(),
  deploymentUpdateMany: vi.fn(),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  cleanupHermesRuntime: vi.fn(),
  copyHermesArchiveToVolume: vi.fn(),
  syncHermesRuntime: vi.fn(),
  stageHermesArchive: vi.fn(),
  resolveHermesImage: vi.fn(),
  beginWorkspaceOperation: vi.fn(),
  getSystemSettings: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    agentRuntime: {
      findFirst: mocks.agentRuntimeFindFirst,
      updateMany: mocks.agentRuntimeUpdateMany,
    },
    sandbox: { updateMany: mocks.sandboxUpdateMany },
    deployment: { updateMany: mocks.deploymentUpdateMany },
  },
}));
vi.mock('@/lib/agents/mutations', () => ({
  createAgent: mocks.createAgent,
  deleteAgent: mocks.deleteAgent,
}));
vi.mock('@/lib/agents/hermes/constants', () => ({ resolveHermesImage: mocks.resolveHermesImage }));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  cleanupHermesRuntime: mocks.cleanupHermesRuntime,
  copyHermesArchiveToVolume: mocks.copyHermesArchiveToVolume,
  syncHermesRuntime: mocks.syncHermesRuntime,
}));
vi.mock('@/lib/agents/hermes/archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/hermes/archive')>();
  return { ...actual, stageHermesArchive: mocks.stageHermesArchive };
});
vi.mock('@/lib/workspace/operation-gate', () => ({ beginWorkspaceOperation: mocks.beginWorkspaceOperation }));
vi.mock('@/lib/admin/settings', () => ({ getSystemSettings: mocks.getSystemSettings }));

import { importHermesArchive } from '@/lib/agents/hermes/import';

describe('importHermesArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveHermesImage.mockReturnValue('nousresearch/hermes-agent:test');
    mocks.getSystemSettings.mockResolvedValue({ hermesArchiveMaxUploadMiB: 17 });
    mocks.stageHermesArchive.mockResolvedValue({
      directory: '/tmp/staged-hermes-home',
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    mocks.beginWorkspaceOperation.mockReturnValue(vi.fn());
    mocks.createAgent.mockResolvedValue({ id: 'agent-1' });
    mocks.agentRuntimeFindFirst.mockResolvedValue({ sandboxId: 'sandbox-1' });
    mocks.agentRuntimeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.sandboxUpdateMany.mockResolvedValue({ count: 1 });
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.copyHermesArchiveToVolume.mockResolvedValue(undefined);
    mocks.syncHermesRuntime.mockResolvedValue({ status: 'setup_required' });
  });

  it('creates a stopped Agent-owned Hermes sandbox and imports into its volume', async () => {
    await expect(importHermesArchive({
      workspaceId: 'workspace-1',
      name: 'Recovered assistant',
      archive: {
        name: 'hermes.zip',
        size: 10,
        arrayBuffer: async () => new ArrayBuffer(0),
      },
    })).resolves.toEqual({ agentId: 'agent-1', sandboxId: 'sandbox-1' });

    expect(mocks.createAgent).toHaveBeenCalledWith('workspace-1', 'Recovered assistant', {
      runtime: 'hermes',
      hermesImage: 'nousresearch/hermes-agent:test',
    });
    expect(mocks.stageHermesArchive).toHaveBeenCalledWith(expect.any(Object), {
      maxUploadMiB: 17,
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        sandbox: { is: { id: 'sandbox-1', workspaceId: 'workspace-1' } },
        source: 'sandbox',
      },
      data: { status: 'copying' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { agentId: 'agent-1', workspaceId: 'workspace-1', kind: 'hermes' },
      data: { status: 'copying', lastError: null },
    });
    expect(mocks.copyHermesArchiveToVolume).toHaveBeenCalledWith({
      directory: '/tmp/staged-hermes-home',
      image: 'nousresearch/hermes-agent:test',
      sandboxId: 'sandbox-1',
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        sandbox: { is: { id: 'sandbox-1', workspaceId: 'workspace-1' } },
        source: 'sandbox',
      },
      data: { status: 'stopped' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { agentId: 'agent-1', workspaceId: 'workspace-1', kind: 'hermes' },
      data: { status: 'setup_required', lastError: null },
    });
    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith('workspace-1', 'agent-1', { start: false });
  });
});
