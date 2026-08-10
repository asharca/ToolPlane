// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  revisionFindFirst: vi.fn(),
  providerFindMany: vi.fn(),
  deploymentFindMany: vi.fn(),
  skillFindMany: vi.fn(),
  allocationCreate: vi.fn(),
  allocationFindUnique: vi.fn(),
  allocationFindUniqueOrThrow: vi.fn(),
  allocationUpdateMany: vi.fn(),
  allocationUpdate: vi.fn(),
  transaction: vi.fn(),
  txAllocationFindUnique: vi.fn(),
  txAllocationUpdateMany: vi.fn(),
  txAllocationCount: vi.fn(),
  txEndpointFindUnique: vi.fn(),
  txQueryRaw: vi.fn(),
  txSandboxUpdateMany: vi.fn(),
  createAgentRecords: vi.fn(),
  updateAgent: vi.fn(),
  setAgentTools: vi.fn(),
  syncHermesRuntime: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    agentEndpointRevision: { findFirst: mocks.revisionFindFirst },
    modelProvider: { findMany: mocks.providerFindMany },
    deployment: { findMany: mocks.deploymentFindMany },
    installedSkill: { findMany: mocks.skillFindMany },
    agentEndpointRuntime: {
      create: mocks.allocationCreate,
      findUnique: mocks.allocationFindUnique,
      findUniqueOrThrow: mocks.allocationFindUniqueOrThrow,
      updateMany: mocks.allocationUpdateMany,
      update: mocks.allocationUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/lib/agents/mutations', () => ({
  createAgentRecords: mocks.createAgentRecords,
  updateAgent: mocks.updateAgent,
  setAgentTools: mocks.setAgentTools,
}));
vi.mock('@/lib/agents/queries', () => ({ getAgent: mocks.getAgent }));
vi.mock('@/lib/agents/hermes/runtime', () => ({
  syncHermesRuntime: mocks.syncHermesRuntime,
}));

import {
  ensureAgentEndpointRuntime,
} from '@/lib/agents/public-api/runtime';

const now = new Date('2026-08-09T12:00:00.000Z');
const revision = {
  id: 'revision-1',
  endpointId: 'endpoint-1',
  version: 1,
  systemPrompt: 'Only use approved public resources.',
  maxSteps: 6,
  runtimeImage: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,
  providerIds: ['provider-1'],
  deploymentIds: ['deployment-1'],
  installedSkillIds: ['skill-1'],
  endpoint: {
    publicId: 'agep_public',
    workspaceId: 'workspace-1',
    sourceAgent: { runtime: { kind: 'hermes' } },
  },
};
const provisioning = {
  id: 'allocation-1',
  endpointId: 'endpoint-1',
  revisionId: 'revision-1',
  subjectHash: 'subject_hash_1',
  runtimeAgentId: null,
  status: 'provisioning',
  lastUsedAt: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};
const loadedAgent = {
  id: 'runtime-agent-1',
  slug: 'endpoint-runtime-allocation-1',
  workspaceId: 'workspace-1',
  modelProviders: [{ provider: { id: 'provider-1' } }],
  servers: [{ deploymentId: 'deployment-1' }],
  skills: [{ installedSkill: { id: 'skill-1' } }],
  toolkits: [],
  sandboxes: [],
  subAgents: [],
  runtime: {
    id: 'runtime-1',
    kind: 'hermes',
    sandbox: { config: { managedBy: 'agent-endpoint-runtime' } },
  },
  publicRuntimeAllocation: {
    id: 'allocation-1',
    revisionId: 'revision-1',
  },
};

describe('isolated public Hermes runtime allocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txAllocationFindUnique.mockReset();
    mocks.revisionFindFirst.mockResolvedValue(revision);
    mocks.providerFindMany.mockResolvedValue([{ id: 'provider-1' }]);
    mocks.deploymentFindMany.mockResolvedValue([{ id: 'deployment-1' }]);
    mocks.skillFindMany.mockResolvedValue([{ id: 'skill-1' }]);
    mocks.allocationCreate.mockResolvedValue(provisioning);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      $queryRaw: mocks.txQueryRaw,
      agentEndpoint: { findUnique: mocks.txEndpointFindUnique },
      agentEndpointRuntime: {
        findUnique: mocks.txAllocationFindUnique,
        updateMany: mocks.txAllocationUpdateMany,
        count: mocks.txAllocationCount,
        create: mocks.allocationCreate,
      },
      sandbox: { updateMany: mocks.txSandboxUpdateMany },
    }));
    mocks.txEndpointFindUnique.mockResolvedValue({
      workspaceId: 'workspace-1',
      status: 'active',
      maxRuntimes: 100,
    });
    mocks.txQueryRaw.mockResolvedValue([]);
    mocks.txAllocationCount.mockResolvedValue(0);
    mocks.txAllocationFindUnique.mockResolvedValueOnce(null).mockResolvedValue({
      runtimeAgentId: null,
      status: 'provisioning',
    });
    mocks.txAllocationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txSandboxUpdateMany.mockResolvedValue({ count: 1 });
    mocks.createAgentRecords.mockResolvedValue({ id: 'runtime-agent-1' });
    mocks.updateAgent.mockResolvedValue(undefined);
    mocks.setAgentTools.mockResolvedValue(undefined);
    mocks.syncHermesRuntime.mockResolvedValue({ status: 'provisioning' });
    mocks.getAgent.mockResolvedValue(loadedAgent);
    mocks.allocationFindUniqueOrThrow.mockResolvedValue({
      ...provisioning,
      runtimeAgentId: 'runtime-agent-1',
      status: 'ready',
      lastUsedAt: now,
    });
    mocks.allocationUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('creates a fresh hidden Hermes graph and projects only immutable revision resources', async () => {
    const result = await ensureAgentEndpointRuntime({
      endpointId: 'endpoint-1',
      revisionId: 'revision-1',
      subjectHash: 'subject_hash_1',
    });

    expect(mocks.createAgentRecords).toHaveBeenCalledWith(
      expect.anything(),
      'workspace-1',
      'Public Endpoint runtime allocation-1',
      'endpoint-runtime-allocation-1',
      {
        runtime: 'hermes',
        hermesImage: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,
      },
      'endpoint-runtime-allocation-1-runtime',
    );
    expect(mocks.updateAgent).toHaveBeenCalledWith('workspace-1', 'runtime-agent-1', {
      name: 'Public Endpoint runtime allocation-1',
      systemPrompt: 'Only use approved public resources.',
      providerId: null,
      providerIds: ['provider-1'],
      model: null,
      maxSteps: 6,
    });
    expect(mocks.txSandboxUpdateMany).toHaveBeenCalledWith({
      where: { agentRuntime: { is: { agentId: 'runtime-agent-1' } } },
      data: { config: { managedBy: 'agent-endpoint-runtime' } },
    });
    expect(mocks.setAgentTools).toHaveBeenCalledWith('workspace-1', 'runtime-agent-1', {
      deploymentIds: ['deployment-1'],
      installedSkillIds: ['skill-1'],
      toolkitIds: [],
      sandboxIds: [],
      subAgentIds: [],
    });
    expect(mocks.syncHermesRuntime).toHaveBeenCalledWith('workspace-1', 'runtime-agent-1', {
      signal: undefined,
    });
    expect(result.agent).toBe(loadedAgent);
    expect(result.allocation.status).toBe('ready');
  });

  it('returns an existing ready allocation without creating or syncing another volume', async () => {
    const ready = {
      ...provisioning,
      runtimeAgentId: 'runtime-agent-1',
      status: 'ready',
    };
    mocks.txAllocationFindUnique.mockReset();
    mocks.txAllocationFindUnique.mockResolvedValue(ready);
    mocks.allocationFindUnique.mockResolvedValue(ready);

    const result = await ensureAgentEndpointRuntime({
      endpointId: 'endpoint-1',
      revisionId: 'revision-1',
      subjectHash: 'subject_hash_1',
    });

    expect(result.agent).toBe(loadedAgent);
    expect(mocks.createAgentRecords).not.toHaveBeenCalled();
    expect(mocks.syncHermesRuntime).not.toHaveBeenCalled();
  });

  it('does not race a second materializer for an active reservation', async () => {
    mocks.txAllocationFindUnique.mockReset();
    mocks.txAllocationFindUnique.mockResolvedValue(provisioning);
    mocks.allocationFindUnique.mockResolvedValue(provisioning);
    mocks.allocationUpdateMany.mockResolvedValue({ count: 0 });

    await expect(ensureAgentEndpointRuntime({
      endpointId: 'endpoint-1',
      revisionId: 'revision-1',
      subjectHash: 'subject_hash_1',
    })).rejects.toMatchObject({
      code: 'provisioning',
    });
    expect(mocks.createAgentRecords).not.toHaveBeenCalled();
  });

  it('rejects a revision whose deployment cannot pass the non-sandbox workspace boundary', async () => {
    mocks.deploymentFindMany.mockResolvedValue([]);

    await expect(ensureAgentEndpointRuntime({
      endpointId: 'endpoint-1',
      revisionId: 'revision-1',
      subjectHash: 'subject_hash_1',
    })).rejects.toMatchObject({ code: 'invalid_revision' });
    expect(mocks.allocationCreate).not.toHaveBeenCalled();
    expect(mocks.createAgentRecords).not.toHaveBeenCalled();
  });

  it('marks a reservation failed when the clean runtime cannot be synchronized', async () => {
    mocks.syncHermesRuntime.mockResolvedValue({
      status: 'error',
      error: 'docker unavailable',
    });

    await expect(ensureAgentEndpointRuntime({
      endpointId: 'endpoint-1',
      revisionId: 'revision-1',
      subjectHash: 'subject_hash_1',
    })).rejects.toMatchObject({
      code: 'materialization_failed',
    });
    expect(mocks.allocationUpdateMany).toHaveBeenCalledWith({
      where: { id: 'allocation-1', status: 'provisioning' },
      data: { status: 'failed', lastError: 'docker unavailable' },
    });
  });
});
