import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  effectiveStatus: vi.fn(),
  killProcess: vi.fn(),
  livePort: vi.fn(),
  restartProcess: vi.fn(),
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  copyDockerVolume: vi.fn(),
  removeDockerSandboxContainer: vi.fn(),
  removeDockerSandboxRuntimeStrict: vi.fn(),
  stopDockerSandboxContainer: vi.fn(),
  resolveSpawnSpec: vi.fn(),
  agentRuntimeUpdateMany: vi.fn(),
  deploymentUpdateMany: vi.fn(),
}));

vi.mock('@/lib/agents/queries', () => ({ getAgent: mocks.getAgent }));
vi.mock('@/lib/process/supervisor', () => ({
  effectiveStatus: mocks.effectiveStatus,
  killProcess: mocks.killProcess,
  livePort: mocks.livePort,
  restartProcess: mocks.restartProcess,
  startProcess: mocks.startProcess,
  stopProcess: mocks.stopProcess,
}));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: mocks.resolveSpawnSpec }));
vi.mock('@/lib/sandboxes/runtime', () => ({
  copyDockerVolume: mocks.copyDockerVolume,
  removeDockerSandboxContainer: mocks.removeDockerSandboxContainer,
  removeDockerSandboxRuntimeStrict: mocks.removeDockerSandboxRuntimeStrict,
  sandboxContainerName: (id: string) => `sandbox-${id}`,
  sandboxSyncContainerName: (id: string) => `sandbox-${id}-sync`,
  sandboxVolumeName: (id: string) => `volume-${id}`,
  stopDockerSandboxContainer: mocks.stopDockerSandboxContainer,
}));
vi.mock('@/lib/db', () => ({
  db: {
    agentRuntime: { updateMany: mocks.agentRuntimeUpdateMany },
    deployment: { updateMany: mocks.deploymentUpdateMany },
  },
}));

import {
  acquireHermesRuntimeWriteLease,
  cleanupHermesRuntime,
  copyHermesRuntimeVolume,
  ensureHermesDashboardReady,
  ensureHermesRuntimeReady,
  stopHermesRuntime,
  syncHermesRuntime,
} from '@/lib/agents/hermes/runtime';

function deletingAgent() {
  return {
    id: 'agent-1',
    provider: { format: 'openai', baseUrl: 'https://example.test', apiKey: 'secret' },
    model: 'model-1',
    modelProviders: [{
      provider: {
        id: 'provider-1',
        name: 'Provider 1',
        format: 'openai',
        baseUrl: 'https://example.test',
        apiKey: 'secret',
        models: ['model-1'],
      },
    }],
    maxSteps: 8,
    runtime: {
      id: 'runtime-1',
      kind: 'hermes',
      image: 'hermes:test',
      status: 'running',
      configHash: null,
      configVersion: 1,
      sandboxId: 'sandbox-1',
      sandbox: {
        deploymentId: 'deployment-1',
        deployment: { id: 'deployment-1', status: 'deleting', installCfg: {} },
      },
    },
  };
}

function volumeCopyAgent({
  agentId,
  runtimeId,
  sandboxId,
  deploymentId,
  deploymentStatus = 'stopped',
  runtimeStatus = 'setup_required',
  providerCount = 1,
}: {
  agentId: string;
  runtimeId: string;
  sandboxId: string;
  deploymentId: string;
  deploymentStatus?: string;
  runtimeStatus?: string;
  providerCount?: number;
}) {
  return {
    id: agentId,
    workspaceId: 'workspace-1',
    modelProviders: Array.from({ length: providerCount }, (_, index) => ({
      provider: { id: `provider-${index}` },
    })),
    runtime: {
      id: runtimeId,
      workspaceId: 'workspace-1',
      kind: 'hermes',
      image: 'hermes:test',
      status: runtimeStatus,
      configHash: null,
      configVersion: 1,
      lastSyncedAt: null,
      sandboxId,
      sandbox: {
        id: sandboxId,
        workspaceId: 'workspace-1',
        deploymentId,
        deployment: {
          id: deploymentId,
          workspaceId: 'workspace-1',
          source: 'sandbox',
          status: deploymentStatus,
          installCfg: {},
        },
      },
    },
  };
}

describe('Hermes sandbox lifecycle isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgent.mockResolvedValue(deletingAgent());
    mocks.effectiveStatus.mockImplementation((_deploymentId: string, status: string) => status);
    mocks.killProcess.mockResolvedValue(undefined);
    mocks.copyDockerVolume.mockResolvedValue(undefined);
    mocks.removeDockerSandboxRuntimeStrict.mockResolvedValue(undefined);
    mocks.stopDockerSandboxContainer.mockResolvedValue(undefined);
    mocks.startProcess.mockResolvedValue(undefined);
    mocks.resolveSpawnSpec.mockReturnValue({ kind: 'sandbox' });
    mocks.agentRuntimeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.deploymentUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('does not sync, start, restart, or stop a runtime retained for deletion', async () => {
    await expect(syncHermesRuntime('workspace-1', 'agent-1')).resolves.toEqual({
      status: 'deleting',
      error: 'The Hermes sandbox has a pending lifecycle operation.',
    });
    await expect(ensureHermesRuntimeReady('workspace-1', 'agent-1')).resolves.toEqual({
      error: 'The Hermes sandbox has a pending lifecycle operation.',
    });
    await expect(ensureHermesDashboardReady('workspace-1', 'agent-1')).resolves.toEqual({
      error: 'The Hermes sandbox has a pending lifecycle operation.',
    });
    await stopHermesRuntime('workspace-1', 'agent-1');

    expect(mocks.startProcess).not.toHaveBeenCalled();
    expect(mocks.restartProcess).not.toHaveBeenCalled();
    expect(mocks.stopProcess).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.agentRuntimeUpdateMany).not.toHaveBeenCalled();
  });

  it('allows explicit runtime cleanup while preserving the deleting status', async () => {
    await expect(cleanupHermesRuntime('workspace-1', 'agent-1')).resolves.toBe(true);

    expect(mocks.killProcess).toHaveBeenCalledWith('deployment-1', {
      preventRestart: true,
      finalStatus: 'deleting',
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'deployment-1',
        workspaceId: 'workspace-1',
        source: 'sandbox',
      },
      data: { status: 'deleting' },
    });
    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith(
      'sandbox-1',
      'volume-sandbox-1',
    );
  });

  it('serializes readiness and cleanup for the same Hermes agent', async () => {
    const agent = deletingAgent();
    agent.runtime.sandbox.deployment.status = 'stopped';
    mocks.getAgent.mockResolvedValue(agent);
    mocks.livePort.mockReturnValue(null);
    let releaseStart: (() => void) | undefined;
    mocks.startProcess.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStart = resolve;
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const ready = ensureHermesRuntimeReady('workspace-serial', 'agent-1');
    await vi.waitFor(() => expect(mocks.startProcess).toHaveBeenCalledOnce());
    const cleanup = cleanupHermesRuntime('workspace-serial', 'agent-1');
    await Promise.resolve();
    expect(mocks.killProcess).not.toHaveBeenCalled();

    mocks.livePort.mockReturnValue(4312);
    releaseStart?.();

    await expect(ready).resolves.toEqual({ port: 4312 });
    await expect(cleanup).resolves.toBe(true);
    expect(mocks.killProcess).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('quiesces a live source, copies its volume, and leaves a syncable target', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    await expect(copyHermesRuntimeVolume('workspace-1', source.id, target.id)).resolves.toEqual({
      status: 'copied',
    });

    expect(mocks.killProcess).toHaveBeenCalledWith('source-deployment', { finalStatus: 'copying' });
    expect(mocks.stopDockerSandboxContainer).toHaveBeenCalledWith('source-sandbox');
    expect(mocks.copyDockerVolume).toHaveBeenCalledWith('volume-source-sandbox', 'volume-target-sandbox');
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'source-deployment',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'workspace-1' },
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'target-deployment',
        workspaceId: 'workspace-1',
        source: 'sandbox',
        status: 'stopped',
      },
      data: { status: 'copying' },
    });
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'target-runtime',
        workspaceId: 'workspace-1',
        agentId: 'target-agent',
        sandboxId: 'target-sandbox',
        kind: 'hermes',
      },
      data: { status: 'copying', lastError: null },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-runtime', workspaceId: 'workspace-1', agentId: 'target-agent' },
      data: expect.objectContaining({
        status: 'stopped',
        configHash: null,
        lastSyncedAt: null,
      }),
    });
    expect(mocks.copyDockerVolume.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.stopDockerSandboxContainer.mock.invocationCallOrder[0],
    );
  });

  it('cleans and leaves the target syncable when volume copy fails, then restores a live source', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));
    mocks.copyDockerVolume.mockRejectedValueOnce(new Error('copy exploded'));

    await expect(copyHermesRuntimeVolume('workspace-1', source.id, target.id)).resolves.toEqual({
      status: 'error',
      error: 'copy exploded',
    });

    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith(
      'target-sandbox',
      'volume-target-sandbox',
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-runtime', workspaceId: 'workspace-1', agentId: 'target-agent' },
      data: expect.objectContaining({ status: 'stopped', lastError: 'copy exploded' }),
    });
    expect(mocks.startProcess).toHaveBeenCalledWith(
      'source-deployment',
      { kind: 'sandbox' },
      { awaitReady: false, workspaceId: 'workspace-1' },
    );
  });

  it('treats a source without an initialized volume as an empty, valid clone', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));
    mocks.copyDockerVolume.mockRejectedValueOnce(new Error('no such volume: volume-source-sandbox'));

    await expect(copyHermesRuntimeVolume(
      'workspace-1',
      source.id,
      target.id,
      async () => ({ copiedRecords: true }),
    )).resolves.toEqual({ status: 'copied', data: { copiedRecords: true } });

    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalled();
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
  });

  it('keeps a copied target finalizable when the source cannot restart', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));
    mocks.startProcess.mockRejectedValueOnce(new Error('restart exploded'));

    await expect(copyHermesRuntimeVolume(
      'workspace-1',
      source.id,
      target.id,
      async () => ({ copiedRecords: true }),
    )).resolves.toEqual({
      status: 'copied',
      data: { copiedRecords: true },
      sourceRestartError: 'The source Hermes runtime could not be restarted after a volume copy: restart exploded',
    });

    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
    expect(mocks.agentRuntimeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'source-runtime', workspaceId: 'workspace-1' },
      data: expect.objectContaining({ status: 'error' }),
    });
  });

  it('cleans the target when mapping copied records fails', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    await expect(copyHermesRuntimeVolume(
      'workspace-1',
      source.id,
      target.id,
      async () => { throw new Error('mapping exploded'); },
    )).resolves.toEqual({ status: 'error', error: 'mapping exploded' });

    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith(
      'target-sandbox',
      'volume-target-sandbox',
    );
    expect(mocks.deploymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'target-deployment', workspaceId: 'workspace-1', source: 'sandbox' },
      data: { status: 'stopped' },
    });
  });

  it('refuses an agent outside the requested workspace before touching volumes', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
    });
    source.workspaceId = 'other-workspace';
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    await expect(copyHermesRuntimeVolume('workspace-1', source.id, target.id)).resolves.toEqual({
      status: 'error',
      error: 'Source and target must be workspace-owned Hermes runtimes.',
    });

    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();
    expect(mocks.removeDockerSandboxRuntimeStrict).not.toHaveBeenCalled();
  });

  it('drains an active Hermes write lease before it snapshots the source volume', async () => {
    const source = volumeCopyAgent({
      agentId: 'source-agent',
      runtimeId: 'source-runtime',
      sandboxId: 'source-sandbox',
      deploymentId: 'source-deployment',
      deploymentStatus: 'running',
      runtimeStatus: 'running',
    });
    const target = volumeCopyAgent({
      agentId: 'target-agent',
      runtimeId: 'target-runtime',
      sandboxId: 'target-sandbox',
      deploymentId: 'target-deployment',
    });
    mocks.getAgent.mockImplementation(async (_workspaceId: string, agentId: string) => (
      agentId === source.id ? source : agentId === target.id ? target : null
    ));

    const activeWrite = acquireHermesRuntimeWriteLease('workspace-1', source.id);
    expect(activeWrite).not.toBeNull();
    const copy = copyHermesRuntimeVolume('workspace-1', source.id, target.id);

    await vi.waitFor(() => {
      expect(acquireHermesRuntimeWriteLease('workspace-1', source.id)).toBeNull();
    });
    expect(mocks.killProcess).not.toHaveBeenCalled();
    expect(mocks.copyDockerVolume).not.toHaveBeenCalled();

    activeWrite?.release();

    await expect(copy).resolves.toEqual({ status: 'copied' });
    expect(mocks.killProcess).toHaveBeenCalledWith('source-deployment', { finalStatus: 'copying' });
    expect(mocks.copyDockerVolume).toHaveBeenCalledWith('volume-source-sandbox', 'volume-target-sandbox');

    const nextWrite = acquireHermesRuntimeWriteLease('workspace-1', source.id);
    expect(nextWrite).not.toBeNull();
    nextWrite?.release();
  });
});
