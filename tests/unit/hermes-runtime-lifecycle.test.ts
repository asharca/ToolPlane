import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  killProcess: vi.fn(),
  livePort: vi.fn(),
  restartProcess: vi.fn(),
  startProcess: vi.fn(),
  stopProcess: vi.fn(),
  removeDockerSandboxContainer: vi.fn(),
  removeDockerSandboxRuntimeStrict: vi.fn(),
  agentRuntimeUpdateMany: vi.fn(),
  deploymentUpdateMany: vi.fn(),
}));

vi.mock('@/lib/agents/queries', () => ({ getAgent: mocks.getAgent }));
vi.mock('@/lib/process/supervisor', () => ({
  killProcess: mocks.killProcess,
  livePort: mocks.livePort,
  restartProcess: mocks.restartProcess,
  startProcess: mocks.startProcess,
  stopProcess: mocks.stopProcess,
}));
vi.mock('@/lib/process/spawn-spec', () => ({ resolveSpawnSpec: vi.fn() }));
vi.mock('@/lib/sandboxes/runtime', () => ({
  removeDockerSandboxContainer: mocks.removeDockerSandboxContainer,
  removeDockerSandboxRuntimeStrict: mocks.removeDockerSandboxRuntimeStrict,
  sandboxContainerName: (id: string) => `sandbox-${id}`,
  sandboxSyncContainerName: (id: string) => `sandbox-${id}-sync`,
  sandboxVolumeName: (id: string) => `volume-${id}`,
}));
vi.mock('@/lib/db', () => ({
  db: {
    agentRuntime: { updateMany: mocks.agentRuntimeUpdateMany },
    deployment: { updateMany: mocks.deploymentUpdateMany },
  },
}));

import {
  cleanupHermesRuntime,
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

describe('Hermes sandbox lifecycle isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgent.mockResolvedValue(deletingAgent());
    mocks.killProcess.mockResolvedValue(undefined);
    mocks.removeDockerSandboxRuntimeStrict.mockResolvedValue(undefined);
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
});
