// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspaceFindFirst: vi.fn(),
  agentFindFirst: vi.fn(),
  cleanupHermesRuntime: vi.fn(),
  getAgentDeleteTargets: vi.fn(),
  deleteAgent: vi.fn(),
  cleanupAgentEndpointRuntimesForSource: vi.fn(),
  isAgentEndpointRuntimeSandboxConfig: vi.fn(),
  killProcess: vi.fn(),
  removeDockerVolumeStrict: vi.fn(),
  removeDockerSandboxRuntimeStrict: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    workspace: { findFirst: mocks.workspaceFindFirst },
    agent: { findFirst: mocks.agentFindFirst },
  },
}));
vi.mock('@/lib/agents/hermes/runtime', () => ({ cleanupHermesRuntime: mocks.cleanupHermesRuntime }));
vi.mock('@/lib/agents/mutations', () => ({
  getAgentDeleteTargets: mocks.getAgentDeleteTargets,
  deleteAgent: mocks.deleteAgent,
}));
vi.mock('@/lib/agents/public-api/maintenance', () => ({
  cleanupAgentEndpointRuntimesForSource: mocks.cleanupAgentEndpointRuntimesForSource,
}));
vi.mock('@/lib/agents/public-api/tool-policy', () => ({
  isAgentEndpointRuntimeSandboxConfig: mocks.isAgentEndpointRuntimeSandboxConfig,
}));
vi.mock('@/lib/process/supervisor', () => ({ killProcess: mocks.killProcess }));
vi.mock('@/lib/sandboxes/runtime', () => ({
  removeDockerVolumeStrict: mocks.removeDockerVolumeStrict,
  removeDockerSandboxRuntimeStrict: mocks.removeDockerSandboxRuntimeStrict,
}));

import { deleteManagedAgent } from '@/lib/agents/deletion';

describe('deleteManagedAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceFindFirst.mockResolvedValue({ ownerId: 'user-1', members: [] });
    mocks.agentFindFirst.mockResolvedValue({
      publicRuntimeAllocation: null,
      publicEndpoints: [],
      runtime: { sandbox: { config: { managedBy: 'agent-runtime' } } },
    });
    mocks.cleanupAgentEndpointRuntimesForSource.mockResolvedValue(true);
    mocks.isAgentEndpointRuntimeSandboxConfig.mockReturnValue(false);
    mocks.cleanupHermesRuntime.mockResolvedValue(true);
    mocks.getAgentDeleteTargets.mockResolvedValue({
      agentIds: ['agent-1'],
      sandboxes: [
        {
          id: 'hermes-sandbox',
          kind: 'hermes',
          deploymentId: 'hermes-deployment',
          volumeName: 'hermes-volume',
          snapshotVolumeNames: ['hermes-snapshot'],
        },
        {
          id: 'docker-sandbox',
          kind: 'docker',
          deploymentId: 'docker-deployment',
          volumeName: 'docker-volume',
          snapshotVolumeNames: ['docker-snapshot'],
        },
      ],
    });
  });

  it('cleans Hermes snapshot volumes before removing the agent record', async () => {
    await expect(deleteManagedAgent({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      actorId: 'user-1',
    })).resolves.toBe(true);

    expect(mocks.cleanupHermesRuntime).toHaveBeenCalledWith('workspace-1', 'agent-1');
    expect(mocks.removeDockerVolumeStrict).toHaveBeenCalledWith('hermes-snapshot');
    expect(mocks.removeDockerVolumeStrict).toHaveBeenCalledWith('docker-snapshot');
    expect(mocks.killProcess).toHaveBeenCalledWith('docker-deployment', {
      preventRestart: true,
      finalStatus: 'deleting',
    });
    expect(mocks.removeDockerSandboxRuntimeStrict).toHaveBeenCalledWith('docker-sandbox', 'docker-volume');
    expect(mocks.deleteAgent).toHaveBeenCalledWith('workspace-1', 'agent-1');
  });
});
