import 'server-only';
import { Prisma, type AgentEndpointRuntime } from '@prisma/client';
import { db } from '@/lib/db';
import {
  createAgentRecords,
  setAgentTools,
  updateAgent,
} from '@/lib/agents/mutations';
import { getAgent } from '@/lib/agents/queries';
import { syncHermesRuntime } from '@/lib/agents/hermes/runtime';
import {
  HERMES_RUNTIME_KIND,
  isPinnedPublicHermesImage,
} from '@/lib/agents/hermes/constants';
import {
  AGENT_ENDPOINT_RUNTIME_MANAGED_BY,
  isAgentEndpointRuntimeSandboxConfig,
} from '@/lib/agents/public-api/tool-policy';

const STALE_RESERVATION_MS = 30 * 60_000;
const MAX_WORKSPACE_PUBLIC_RUNTIMES = 1_000;

type LoadedAgent = NonNullable<Awaited<ReturnType<typeof getAgent>>>;

export type LoadedAgentEndpointRuntimeAgent = LoadedAgent & {
  runtime: NonNullable<LoadedAgent['runtime']>;
};

export type EnsuredAgentEndpointRuntime = {
  allocation: AgentEndpointRuntime;
  agent: LoadedAgentEndpointRuntimeAgent;
};

export type AgentEndpointRuntimeAllocationErrorCode =
  | 'invalid_revision'
  | 'quota_exceeded'
  | 'provisioning'
  | 'materialization_failed';

export class AgentEndpointRuntimeAllocationError extends Error {
  constructor(
    public readonly code: AgentEndpointRuntimeAllocationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentEndpointRuntimeAllocationError';
  }
}

type EndpointRevision = NonNullable<Awaited<ReturnType<typeof loadEndpointRevision>>>;

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validateSubjectHash(subjectHash: string): string {
  const normalized = subjectHash.trim();
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new AgentEndpointRuntimeAllocationError(
      'invalid_revision',
      'The public Agent runtime subject is invalid.',
    );
  }
  return normalized;
}

async function loadEndpointRevision(endpointId: string, revisionId: string) {
  return db.agentEndpointRevision.findFirst({
    where: { id: revisionId, endpointId },
    select: {
      id: true,
      endpointId: true,
      version: true,
      systemPrompt: true,
      maxSteps: true,
      runtimeImage: true,
      providerIds: true,
      deploymentIds: true,
      installedSkillIds: true,
      endpoint: {
        select: {
          publicId: true,
          workspaceId: true,
          sourceAgent: {
            select: { runtime: { select: { kind: true } } },
          },
        },
      },
    },
  });
}

async function validateRevisionResources(revision: EndpointRevision): Promise<void> {
  if (
    revision.endpoint.sourceAgent.runtime?.kind !== HERMES_RUNTIME_KIND
    || !isPinnedPublicHermesImage(revision.runtimeImage)
  ) {
    throw new AgentEndpointRuntimeAllocationError(
      'invalid_revision',
      'The Agent Endpoint revision cannot be materialized as a Hermes runtime.',
    );
  }

  const workspaceId = revision.endpoint.workspaceId;
  const providerIds = uniqueIds(revision.providerIds);
  const deploymentIds = uniqueIds(revision.deploymentIds);
  const installedSkillIds = uniqueIds(revision.installedSkillIds);
  const [providers, deployments, skills] = await Promise.all([
    db.modelProvider.findMany({
      where: { workspaceId, id: { in: providerIds } },
      select: { id: true },
    }),
    db.deployment.findMany({
      where: {
        workspaceId,
        id: { in: deploymentIds },
        OR: [{ source: null }, { source: { not: 'sandbox' } }],
        publicInvocable: true,
      },
      select: { id: true },
    }),
    db.installedSkill.findMany({
      where: { workspaceId, id: { in: installedSkillIds }, agentInvocable: true },
      select: { id: true },
    }),
  ]);

  if (
    providerIds.length === 0
    || providers.length !== providerIds.length
    || deployments.length !== deploymentIds.length
    || skills.length !== installedSkillIds.length
  ) {
    throw new AgentEndpointRuntimeAllocationError(
      'invalid_revision',
      'The Agent Endpoint revision references unavailable or unsafe resources.',
    );
  }
}

async function reserveAllocation(params: {
  endpointId: string;
  revisionId: string;
  subjectHash: string;
  runId?: string;
}): Promise<{ allocation: AgentEndpointRuntime; ownsReservation: boolean }> {
  const reserved = await db.$transaction(async (tx) => {
    const endpointHint = await tx.agentEndpoint.findUnique({
      where: { id: params.endpointId },
      select: { workspaceId: true },
    });
    if (!endpointHint) {
      throw new AgentEndpointRuntimeAllocationError('invalid_revision', 'Agent Endpoint not found.');
    }
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${endpointHint.workspaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "AgentEndpoint" WHERE "id" = ${params.endpointId} FOR UPDATE`;
    const endpoint = await tx.agentEndpoint.findUnique({
      where: { id: params.endpointId },
      select: { workspaceId: true, status: true, maxRuntimes: true },
    });
    if (!endpoint || endpoint.status !== 'active') {
      throw new AgentEndpointRuntimeAllocationError(
        'provisioning',
        'The Agent Endpoint is no longer active.',
      );
    }
    const existing = await tx.agentEndpointRuntime.findUnique({
      where: {
        endpointId_revisionId_subjectHash: {
          endpointId: params.endpointId,
          revisionId: params.revisionId,
          subjectHash: params.subjectHash,
        },
      },
    });
    if (existing) {
      await tx.$queryRaw`SELECT "id" FROM "AgentEndpointRuntime" WHERE "id" = ${existing.id} FOR UPDATE`;
      if (params.runId) await bindRunToAllocation(tx, params, existing.id);
      return { allocation: existing, ownsReservation: false };
    }

    const endpointCount = await tx.agentEndpointRuntime.count({
      where: { endpointId: params.endpointId },
    });
    const workspaceCount = await tx.agentEndpointRuntime.count({
      where: { endpoint: { workspaceId: endpoint.workspaceId } },
    });
    if (endpointCount >= endpoint.maxRuntimes || workspaceCount >= MAX_WORKSPACE_PUBLIC_RUNTIMES) {
      throw new AgentEndpointRuntimeAllocationError(
        'quota_exceeded',
        'The persistent public runtime quota has been reached.',
      );
    }
    const allocation = await tx.agentEndpointRuntime.create({
      data: {
        endpointId: params.endpointId,
        revisionId: params.revisionId,
        subjectHash: params.subjectHash,
        status: 'provisioning',
      },
    });
    if (params.runId) await bindRunToAllocation(tx, params, allocation.id);
    return { allocation, ownsReservation: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (reserved.ownsReservation) return reserved;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const allocation = await db.agentEndpointRuntime.findUnique({
      where: {
        endpointId_revisionId_subjectHash: {
          endpointId: params.endpointId,
          revisionId: params.revisionId,
          subjectHash: params.subjectHash,
        },
      },
    });
    if (!allocation) continue;
    if (allocation.status === 'ready') {
      return { allocation, ownsReservation: false };
    }

    const claimed = await db.agentEndpointRuntime.updateMany({
      where: {
        id: allocation.id,
        updatedAt: allocation.updatedAt,
        OR: [
          { status: 'failed' },
          {
            status: 'provisioning',
            updatedAt: { lt: new Date(Date.now() - STALE_RESERVATION_MS) },
          },
        ],
      },
      data: { status: 'provisioning', lastError: null },
    });
    if (claimed.count === 1) {
      const reserved = await db.agentEndpointRuntime.findUniqueOrThrow({
        where: { id: allocation.id },
      });
      return { allocation: reserved, ownsReservation: true };
    }
    return { allocation, ownsReservation: false };
  }

  throw new AgentEndpointRuntimeAllocationError(
    'provisioning',
    'The isolated Agent runtime is still being reserved.',
  );
}

async function bindRunToAllocation(
  tx: Prisma.TransactionClient,
  params: { endpointId: string; revisionId: string; runId?: string },
  allocationId: string,
): Promise<void> {
  if (!params.runId) return;
  const allocation = await tx.agentEndpointRuntime.findUnique({
    where: { id: allocationId },
    select: { status: true, operationId: true, operationExpiresAt: true },
  });
  if (
    !allocation
    || ['stopping', 'deleting'].includes(allocation.status)
    || (
      allocation.operationId
      && allocation.operationExpiresAt
      && allocation.operationExpiresAt > new Date()
    )
  ) {
    throw new AgentEndpointRuntimeAllocationError(
      'provisioning',
      'The isolated Agent runtime is under lifecycle maintenance.',
    );
  }
  // One durable active run per persistent Hermes volume. This is deliberately
  // stricter than per-conversation serialization and remains valid when two
  // requests land on different Next.js workers.
  const competingRuns = await tx.agentRun.count({
    where: {
      runtimeAllocationId: allocationId,
      id: { not: params.runId },
      status: { in: ['provisioning', 'running'] },
    },
  });
  if (competingRuns > 0) {
    throw new AgentEndpointRuntimeAllocationError(
      'provisioning',
      'The isolated Agent runtime already has an active response.',
    );
  }
  const bound = await tx.agentRun.updateMany({
    where: {
      id: params.runId,
      endpointId: params.endpointId,
      revisionId: params.revisionId,
      status: 'provisioning',
      cancelRequestedAt: null,
      OR: [{ runtimeAllocationId: null }, { runtimeAllocationId: allocationId }],
    },
    data: { runtimeAllocationId: allocationId },
  });
  if (bound.count !== 1) {
    throw new AgentEndpointRuntimeAllocationError(
      'provisioning',
      'The Agent response no longer owns this runtime reservation.',
    );
  }
}

function hiddenRuntimeSlug(allocationId: string): string {
  const suffix = allocationId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `endpoint-runtime-${suffix}`;
}

async function ensureRuntimeAgentRecord(
  revision: EndpointRevision,
  allocation: AgentEndpointRuntime,
): Promise<string> {
  if (allocation.runtimeAgentId) return allocation.runtimeAgentId;

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AgentEndpointRuntime" WHERE "id" = ${allocation.id} FOR UPDATE`;
    const current = await tx.agentEndpointRuntime.findUnique({
      where: { id: allocation.id },
      select: { runtimeAgentId: true, status: true },
    });
    if (!current || current.status !== 'provisioning') {
      throw new Error('The Agent Endpoint runtime reservation is no longer active.');
    }
    if (current.runtimeAgentId) return current.runtimeAgentId;

    const slug = hiddenRuntimeSlug(allocation.id);
    const agent = await createAgentRecords(
      tx,
      revision.endpoint.workspaceId,
      `Public Endpoint runtime ${allocation.id}`,
      slug,
      { runtime: HERMES_RUNTIME_KIND, hermesImage: revision.runtimeImage },
      `${slug}-runtime`,
    );
    const marked = await tx.sandbox.updateMany({
      where: { agentRuntime: { is: { agentId: agent.id } } },
      data: { config: { managedBy: AGENT_ENDPOINT_RUNTIME_MANAGED_BY } },
    });
    if (marked.count !== 1) {
      throw new Error('The isolated Hermes sandbox could not be marked as hidden.');
    }
    const linked = await tx.agentEndpointRuntime.updateMany({
      where: {
        id: allocation.id,
        status: 'provisioning',
        runtimeAgentId: null,
      },
      data: { runtimeAgentId: agent.id },
    });
    if (linked.count !== 1) {
      throw new Error('The Agent Endpoint runtime reservation changed during materialization.');
    }
    return agent.id;
  }, { maxWait: 10_000, timeout: 30_000 });
}

function isLoadedHermesAgent(agent: LoadedAgent | null): agent is LoadedAgentEndpointRuntimeAgent {
  return Boolean(agent?.runtime && agent.runtime.kind === HERMES_RUNTIME_KIND);
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function runtimeGraphMatchesRevision(
  agent: LoadedAgentEndpointRuntimeAgent,
  revision: EndpointRevision,
): boolean {
  return agent.publicRuntimeAllocation?.revisionId === revision.id
    && isAgentEndpointRuntimeSandboxConfig(agent.runtime.sandbox.config)
    && sameIds(
      agent.modelProviders.map(({ provider }) => provider.id),
      uniqueIds(revision.providerIds),
    )
    && sameIds(
      agent.servers.map(({ deploymentId }) => deploymentId),
      uniqueIds(revision.deploymentIds),
    )
    && sameIds(
      agent.skills.map(({ installedSkill }) => installedSkill.id),
      uniqueIds(revision.installedSkillIds),
    )
    && agent.toolkits.length === 0
    && agent.sandboxes.length === 0
    && agent.subAgents.length === 0;
}

async function loadReadyAllocation(
  allocation: AgentEndpointRuntime,
  revision: EndpointRevision,
): Promise<EnsuredAgentEndpointRuntime | null> {
  if (allocation.status !== 'ready' || !allocation.runtimeAgentId) return null;
  const agent = await getAgent(revision.endpoint.workspaceId, allocation.runtimeAgentId);
  if (!isLoadedHermesAgent(agent) || !runtimeGraphMatchesRevision(agent, revision)) return null;
  const touchedAt = new Date();
  const touched = await db.agentEndpointRuntime.updateMany({
    where: {
      id: allocation.id,
      status: 'ready',
      runtimeAgentId: allocation.runtimeAgentId,
    },
    data: { lastUsedAt: touchedAt },
  });
  if (touched.count !== 1) return null;
  return {
    allocation: { ...allocation, lastUsedAt: touchedAt },
    agent,
  };
}

async function materializeAllocation(
  revision: EndpointRevision,
  allocation: AgentEndpointRuntime,
  options: { runId?: string; signal?: AbortSignal } = {},
): Promise<EnsuredAgentEndpointRuntime> {
  try {
    options.signal?.throwIfAborted();
    const runtimeAgentId = await ensureRuntimeAgentRecord(revision, allocation);
    await assertProvisioningRun(options.runId, allocation.id);
    options.signal?.throwIfAborted();
    await updateAgent(revision.endpoint.workspaceId, runtimeAgentId, {
      name: `Public Endpoint runtime ${allocation.id}`,
      // Standard Hermes Agents retain ownership of their prompt in the Hermes
      // volume. buildProjection reads this public runtime's immutable revision
      // instead of this legacy Agent field.
      systemPrompt: revision.systemPrompt,
      providerId: null,
      providerIds: uniqueIds(revision.providerIds),
      model: null,
      maxSteps: revision.maxSteps,
    });
    await assertProvisioningRun(options.runId, allocation.id);
    options.signal?.throwIfAborted();
    await setAgentTools(revision.endpoint.workspaceId, runtimeAgentId, {
      deploymentIds: uniqueIds(revision.deploymentIds),
      installedSkillIds: uniqueIds(revision.installedSkillIds),
      toolkitIds: [],
      sandboxIds: [],
      subAgentIds: [],
    });

    const projectedAgent = await getAgent(revision.endpoint.workspaceId, runtimeAgentId);
    if (!isLoadedHermesAgent(projectedAgent) || !runtimeGraphMatchesRevision(projectedAgent, revision)) {
      throw new Error('The isolated Hermes runtime graph does not match its immutable revision.');
    }

    await assertProvisioningRun(options.runId, allocation.id);
    options.signal?.throwIfAborted();
    const synced = await syncHermesRuntime(revision.endpoint.workspaceId, runtimeAgentId, {
      signal: options.signal,
    });
    if (
      synced.error
      || synced.status === 'error'
      || synced.status === 'native'
      || synced.status === 'setup_required'
    ) {
      throw new Error(synced.error || `Hermes runtime sync returned ${synced.status}.`);
    }
    await assertProvisioningRun(options.runId, allocation.id);
    options.signal?.throwIfAborted();

    const agent = await getAgent(revision.endpoint.workspaceId, runtimeAgentId);
    if (!isLoadedHermesAgent(agent) || !runtimeGraphMatchesRevision(agent, revision)) {
      throw new Error('The isolated Hermes runtime could not be loaded after synchronization.');
    }
    const readyAt = new Date();
    const markedReady = await db.agentEndpointRuntime.updateMany({
      where: {
        id: allocation.id,
        status: 'provisioning',
        runtimeAgentId,
      },
      data: {
        status: 'ready',
        lastUsedAt: readyAt,
        lastError: null,
      },
    });
    if (markedReady.count !== 1) {
      throw new Error('The runtime reservation changed before it became ready.');
    }
    const ready = await db.agentEndpointRuntime.findUniqueOrThrow({
      where: { id: allocation.id },
    });
    return { allocation: ready, agent };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .trim()
      .slice(0, 4_000) || 'Could not materialize the isolated Hermes runtime.';
    await db.agentEndpointRuntime.updateMany({
      where: { id: allocation.id, status: 'provisioning' },
      data: { status: 'failed', lastError: detail },
    }).catch(() => undefined);
    throw new AgentEndpointRuntimeAllocationError(
      'materialization_failed',
      'The isolated Agent runtime could not be prepared.',
      { cause: error },
    );
  }
}

async function assertProvisioningRun(runId: string | undefined, allocationId: string): Promise<void> {
  if (!runId) return;
  const active = await db.agentRun.count({
    where: {
      id: runId,
      runtimeAllocationId: allocationId,
      status: 'provisioning',
      cancelRequestedAt: null,
    },
  });
  if (active !== 1) throw new Error('The Agent response was cancelled during runtime provisioning.');
}

/**
 * Materialize one clean Hermes runtime for an immutable Endpoint revision and
 * HMAC-namespaced public subject. It never clones or reads the source Agent's
 * volume: a fresh Agent, sandbox, deployment and Docker volume are created,
 * then only the revision's providers, direct deployments and skills are
 * projected into it.
 */
export async function ensureAgentEndpointRuntime(input: {
  endpointId: string;
  revisionId: string;
  subjectHash: string;
  runId?: string;
  signal?: AbortSignal;
}): Promise<EnsuredAgentEndpointRuntime> {
  input.signal?.throwIfAborted();
  const subjectHash = validateSubjectHash(input.subjectHash);
  const revision = await loadEndpointRevision(input.endpointId, input.revisionId);
  if (!revision) {
    throw new AgentEndpointRuntimeAllocationError(
      'invalid_revision',
      'The Agent Endpoint revision was not found.',
    );
  }
  await validateRevisionResources(revision);
  input.signal?.throwIfAborted();

  const reserved = await reserveAllocation({
    endpointId: input.endpointId,
    revisionId: input.revisionId,
    subjectHash,
    runId: input.runId,
  });
  if (!reserved.ownsReservation) {
    const ready = await loadReadyAllocation(
      reserved.allocation,
      revision,
    );
    if (ready) return ready;
    if (reserved.allocation.status === 'ready') {
      await db.agentEndpointRuntime.updateMany({
        where: {
          id: reserved.allocation.id,
          status: 'ready',
          updatedAt: reserved.allocation.updatedAt,
        },
        data: {
          status: 'failed',
          lastError: 'The isolated Hermes runtime graph no longer matches its revision.',
        },
      });
      const reclaimed = await reserveAllocation({
        endpointId: input.endpointId,
        revisionId: input.revisionId,
        subjectHash,
        runId: input.runId,
      });
      if (reclaimed.ownsReservation) {
        return materializeAllocation(revision, reclaimed.allocation, input);
      }
    }
    throw new AgentEndpointRuntimeAllocationError(
      'provisioning',
      'The isolated Agent runtime is still being prepared.',
    );
  }
  return materializeAllocation(revision, reserved.allocation, input);
}
