import 'server-only';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { cleanupHermesRuntime, stopHermesRuntime } from '@/lib/agents/hermes/runtime';
import { deleteAgent } from '@/lib/agents/mutations';
import { abortAgentApiRun } from '@/lib/agents/public-api/run-control';
import { deleteAgentConversationForPrincipal } from '@/lib/agents/public-api/conversations';
import { pruneAgentApiUsageBuckets } from '@/lib/agents/public-api/rate-limit';
import type { AgentApiPrincipal } from '@/lib/agents/public-api/auth';

const STALE_RUNTIME_OPERATION_MS = 15 * 60_000;
const STALE_RUNTIME_PROVISIONING_MS = 30 * 60_000;
const PUBLIC_RUNTIME_OPERATION_LEASE_MS = 10 * 60_000;

export async function cleanupAgentEndpointRuntimeIfUnused(allocationId: string): Promise<boolean> {
  const operationId = randomUUID();
  const operationNow = new Date();
  const allocation = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AgentEndpointRuntime" WHERE "id" = ${allocationId} FOR UPDATE`;
    const current = await tx.agentEndpointRuntime.findUnique({
      where: { id: allocationId },
      include: {
        endpoint: { select: { workspaceId: true } },
        conversations: { select: { deletingAt: true, conversationId: true } },
      },
    });
    const staleOperationBefore = new Date(operationNow.getTime() - STALE_RUNTIME_OPERATION_MS);
    const staleProvisioningBefore = new Date(
      operationNow.getTime() - STALE_RUNTIME_PROVISIONING_MS,
    );
    if (
      !current
      || current.conversations.some((conversation) => !conversation.deletingAt)
      || (current.status === 'provisioning' && current.updatedAt >= staleProvisioningBefore)
      || (
        current.operationId
        && current.operationExpiresAt
        && current.operationExpiresAt > operationNow
      )
      || (
        ['stopping', 'deleting'].includes(current.status)
        && current.updatedAt >= staleOperationBefore
      )
    ) return null;
    const activeRuns = await tx.agentRun.count({
      where: {
        runtimeAllocationId: current.id,
        status: { in: ['provisioning', 'running'] },
      },
    });
    if (activeRuns > 0) return null;
    const claimed = await tx.agentEndpointRuntime.updateMany({
      where: {
        id: current.id,
        status: current.status,
        updatedAt: current.updatedAt,
        conversations: { none: { deletingAt: null } },
      },
      data: {
        status: 'deleting',
        operationId,
        operationExpiresAt: new Date(operationNow.getTime() + PUBLIC_RUNTIME_OPERATION_LEASE_MS),
        lastError: null,
      },
    });
    return claimed.count === 1 ? current : null;
  });
  if (!allocation) return false;

  try {
    if (allocation.runtimeAgentId) {
      const cleaned = await cleanupHermesRuntime(
        allocation.endpoint.workspaceId,
        allocation.runtimeAgentId,
        { timeoutMs: 60_000 },
      );
      if (!cleaned) throw new Error('Hermes runtime cleanup was not admitted.');
      await deleteAgent(allocation.endpoint.workspaceId, allocation.runtimeAgentId);
    } else if (allocation.conversations.length) {
      await db.conversation.deleteMany({
        where: { id: { in: allocation.conversations.map((conversation) => conversation.conversationId) } },
      });
    }
    const deleted = await db.agentEndpointRuntime.deleteMany({
      where: {
        id: allocation.id,
        operationId,
        conversations: { none: { deletingAt: null } },
      },
    });
    return deleted.count === 1;
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    await db.agentEndpointRuntime.updateMany({
      where: { id: allocation.id, status: 'deleting', operationId },
      data: {
        status: 'failed',
        operationId: null,
        operationExpiresAt: null,
        lastError: detail || 'Runtime cleanup failed.',
      },
    }).catch(() => undefined);
    return false;
  }
}

export async function stopAgentEndpointRuntimeIfIdle(
  allocationId: string,
  idleBefore: Date,
): Promise<boolean> {
  const operationId = randomUUID();
  const operationNow = new Date();
  const allocation = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AgentEndpointRuntime" WHERE "id" = ${allocationId} FOR UPDATE`;
    const current = await tx.agentEndpointRuntime.findUnique({
      where: { id: allocationId },
      include: { endpoint: { select: { workspaceId: true } } },
    });
    if (
      !current
      || !current.runtimeAgentId
      || !current.lastUsedAt
      || (
        current.operationId
        && current.operationExpiresAt
        && current.operationExpiresAt > operationNow
      )
      || (
        current.status === 'ready'
          ? current.lastUsedAt >= idleBefore
          : current.status !== 'stopping'
            || current.updatedAt >= new Date(Date.now() - STALE_RUNTIME_OPERATION_MS)
      )
    ) return null;
    const activeRuns = await tx.agentRun.count({
      where: {
        runtimeAllocationId: current.id,
        status: { in: ['provisioning', 'running'] },
      },
    });
    if (activeRuns > 0) return null;
    const claimed = await tx.agentEndpointRuntime.updateMany({
      where: { id: current.id, status: current.status, updatedAt: current.updatedAt },
      data: {
        status: 'stopping',
        operationId,
        operationExpiresAt: new Date(operationNow.getTime() + PUBLIC_RUNTIME_OPERATION_LEASE_MS),
      },
    });
    return claimed.count === 1 ? current : null;
  });
  if (!allocation?.runtimeAgentId) return false;

  try {
    await stopHermesRuntime(allocation.endpoint.workspaceId, allocation.runtimeAgentId);
    const stopped = await db.agentRuntime.findFirst({
      where: {
        workspaceId: allocation.endpoint.workspaceId,
        agentId: allocation.runtimeAgentId,
        kind: 'hermes',
        status: 'stopped',
      },
      select: { id: true },
    });
    if (!stopped) throw new Error('Hermes runtime did not enter the stopped state.');
    await db.agentEndpointRuntime.updateMany({
      where: { id: allocation.id, status: 'stopping', operationId },
      data: {
        status: 'ready',
        operationId: null,
        operationExpiresAt: null,
        lastError: null,
      },
    });
    return true;
  } catch (error) {
    await db.agentEndpointRuntime.updateMany({
      where: { id: allocation.id, status: 'stopping', operationId },
      data: {
        status: 'failed',
        operationId: null,
        operationExpiresAt: null,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      },
    }).catch(() => undefined);
    return false;
  }
}

/** Disable and fully remove every hidden runtime before deleting its source Agent. */
export async function cleanupAgentEndpointRuntimesForSource(
  workspaceId: string,
  sourceAgentId: string,
): Promise<boolean> {
  const endpoint = await db.agentEndpoint.findFirst({
    where: { workspaceId, sourceAgentId },
    select: { id: true },
  });
  if (!endpoint) return true;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AgentEndpoint" WHERE "id" = ${endpoint.id} FOR UPDATE`;
    await tx.agentEndpoint.update({ where: { id: endpoint.id }, data: { status: 'disabled' } });
  });
  const activeRuns = await db.agentRun.findMany({
    where: { endpointId: endpoint.id, status: { in: ['provisioning', 'running'] } },
    select: { id: true, publicId: true },
  });
  await db.agentRun.updateMany({
    where: { id: { in: activeRuns.map((run) => run.id) } },
    data: {
      status: 'cancelled',
      errorCode: 'cancelled',
      cancelRequestedAt: new Date(),
      completedAt: new Date(),
    },
  });
  for (const run of activeRuns) abortAgentApiRun(run.publicId);

  for (let pass = 0; pass < 5; pass += 1) {
    const runtimeIds = await db.agentEndpointRuntime.findMany({
      where: { endpointId: endpoint.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!runtimeIds.length) return true;
    for (const { id } of runtimeIds) {
      const operationId = randomUUID();
      const operationNow = new Date();
      const runtime = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AgentEndpointRuntime" WHERE "id" = ${id} FOR UPDATE`;
        const current = await tx.agentEndpointRuntime.findUnique({
          where: { id },
          select: {
            id: true,
            runtimeAgentId: true,
            status: true,
            updatedAt: true,
            operationId: true,
            operationExpiresAt: true,
            conversations: { select: { conversationId: true } },
          },
        });
        if (!current) return null;
        if (
          current.operationId
          && current.operationExpiresAt
          && current.operationExpiresAt > operationNow
        ) return { busy: true as const };
        await tx.agentRun.updateMany({
          where: {
            runtimeAllocationId: current.id,
            status: { in: ['provisioning', 'running'] },
          },
          data: {
            status: 'cancelled',
            errorCode: 'cancelled',
            cancelRequestedAt: operationNow,
            completedAt: operationNow,
          },
        });
        const claimed = await tx.agentEndpointRuntime.updateMany({
          where: {
            id: current.id,
            status: current.status,
            updatedAt: current.updatedAt,
          },
          data: {
            status: 'deleting',
            operationId,
            operationExpiresAt: new Date(operationNow.getTime() + PUBLIC_RUNTIME_OPERATION_LEASE_MS),
          },
        });
        return claimed.count === 1
          ? { busy: false as const, ...current }
          : { busy: true as const };
      });
      if (!runtime) continue;
      if (runtime.busy) return false;
      try {
        if (runtime.runtimeAgentId) {
          if (!await cleanupHermesRuntime(
            workspaceId,
            runtime.runtimeAgentId,
            { timeoutMs: 60_000 },
          )) throw new Error('Hermes runtime cleanup was not admitted.');
          await deleteAgent(workspaceId, runtime.runtimeAgentId);
        } else if (runtime.conversations.length) {
          await db.conversation.deleteMany({
            where: {
              id: { in: runtime.conversations.map((conversation) => conversation.conversationId) },
            },
          });
        }
        const deleted = await db.agentEndpointRuntime.deleteMany({
          where: { id: runtime.id, operationId },
        });
        if (deleted.count !== 1) return false;
      } catch (error) {
        await db.agentEndpointRuntime.updateMany({
          where: { id: runtime.id, status: 'deleting', operationId },
          data: {
            status: 'failed',
            operationId: null,
            operationExpiresAt: null,
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
          },
        }).catch(() => undefined);
        return false;
      }
    }
  }
  return await db.agentEndpointRuntime.count({ where: { endpointId: endpoint.id } }) === 0;
}

function maintenancePrincipal(row: {
  endpoint: {
    id: string;
    publicId: string;
    workspaceId: string;
    sourceAgentId: string;
    currentRevisionId: string | null;
    rpmLimit: number;
    dailyRequestLimit: number;
    maxConcurrent: number;
    timeoutSeconds: number;
    retentionDays: number;
  };
  clientId: string;
}): AgentApiPrincipal {
  return {
    credentialType: 'api_key',
    endpointId: row.endpoint.id,
    endpointPublicId: row.endpoint.publicId,
    workspaceId: row.endpoint.workspaceId,
    sourceAgentId: row.endpoint.sourceAgentId,
    revisionId: row.endpoint.currentRevisionId ?? '',
    clientId: row.clientId,
    keyId: null,
    subjectHash: null,
    origin: null,
    scopes: [],
    limits: {
      rpm: row.endpoint.rpmLimit,
      dailyRequests: row.endpoint.dailyRequestLimit,
      maxConcurrent: row.endpoint.maxConcurrent,
      timeoutSeconds: row.endpoint.timeoutSeconds,
      retentionDays: row.endpoint.retentionDays,
    },
    rateBuckets: {
      endpointRpm: row.endpoint.rpmLimit,
      clientRpm: row.endpoint.rpmLimit,
      endpointDaily: row.endpoint.dailyRequestLimit,
      clientDaily: row.endpoint.dailyRequestLimit,
    },
  };
}

async function acquireMaintenanceLease(
  name: string,
  now: Date,
  durationMs: number,
): Promise<(() => Promise<void>) | null> {
  const ownerId = randomUUID();
  const expiresAt = new Date(now.getTime() + durationMs);
  const rows = await db.$queryRaw<Array<{ name: string }>>`
    INSERT INTO "AgentApiMaintenanceLease" ("name", "ownerId", "expiresAt", "updatedAt")
    VALUES (${name}, ${ownerId}, ${expiresAt}, ${now})
    ON CONFLICT ("name") DO UPDATE
    SET "ownerId" = EXCLUDED."ownerId",
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = EXCLUDED."updatedAt"
    WHERE "AgentApiMaintenanceLease"."expiresAt" < ${now}
    RETURNING "name"
  `;
  if (!rows[0]) return null;
  return async () => {
    await db.agentApiMaintenanceLease.deleteMany({ where: { name, ownerId } });
  };
}

type ConversationCandidate = {
  id: string;
  publicId: string;
  clientId: string;
  runtimeAllocationId: string;
  endpoint: {
    id: string;
    publicId: string;
    workspaceId: string;
    sourceAgentId: string;
    currentRevisionId: string | null;
    rpmLimit: number;
    dailyRequestLimit: number;
    maxConcurrent: number;
    timeoutSeconds: number;
    retentionDays: number;
  };
};

/** Bounded, cross-worker-safe startup/hourly retention and orphan cleanup pass. */
export async function runAgentApiMaintenance(now = new Date()): Promise<{
  conversations: number;
  runs: number;
  runtimes: number;
  usageBuckets: number;
}> {
  const release = await acquireMaintenanceLease('retention', now, 30 * 60_000);
  if (!release) return { conversations: 0, runs: 0, runtimes: 0, usageBuckets: 0 };
  try {
    const deadline = Date.now() + 4 * 60_000;
    const staleRuns: Array<{ id: string; publicId: string }> = [];
    while (staleRuns.length < 1_000 && Date.now() < deadline) {
      const batch = await db.$queryRaw<Array<{ id: string; publicId: string }>>`
        WITH candidates AS (
          SELECT r."id"
          FROM "AgentRun" r
          WHERE r."status" IN ('provisioning', 'running')
            AND r."deadlineAt" < ${now}
          ORDER BY r."deadlineAt" ASC
          LIMIT 100
          FOR UPDATE OF r SKIP LOCKED
        )
        UPDATE "AgentRun" r
        SET "status" = CASE
              WHEN r."cancelRequestedAt" IS NULL THEN 'failed'
              ELSE 'cancelled'
            END,
            "errorCode" = CASE
              WHEN r."cancelRequestedAt" IS NULL THEN 'request_timeout'
              ELSE 'cancelled'
            END,
            "cancelRequestedAt" = COALESCE(r."cancelRequestedAt", ${now}),
            "completedAt" = ${now},
            "updatedAt" = ${now}
        FROM candidates
        WHERE r."id" = candidates."id"
          AND r."status" IN ('provisioning', 'running')
        RETURNING r."id", r."publicId"
      `;
      staleRuns.push(...batch);
      for (const run of batch) abortAgentApiRun(run.publicId);
      if (batch.length < 100) break;
    }

    const conversationIds = await db.$queryRaw<Array<{ id: string }>>`
      SELECT pc."id"
      FROM "AgentPublicConversation" pc
      JOIN "AgentEndpoint" e ON e."id" = pc."endpointId"
      WHERE pc."deletingAt" IS NOT NULL
         OR pc."createdAt" < (CAST(${now} AS timestamp) - (e."retentionDays" * INTERVAL '1 day'))
      ORDER BY pc."updatedAt" ASC
      LIMIT 50
    `;
    const candidates = await db.agentPublicConversation.findMany({
      where: { id: { in: conversationIds.map((row) => row.id) } },
      select: {
        id: true,
        publicId: true,
        clientId: true,
        runtimeAllocationId: true,
        endpoint: {
          select: {
            id: true,
            publicId: true,
            workspaceId: true,
            sourceAgentId: true,
            currentRevisionId: true,
            rpmLimit: true,
            dailyRequestLimit: true,
            maxConcurrent: true,
            timeoutSeconds: true,
            retentionDays: true,
          },
        },
      },
    }) as ConversationCandidate[];
    let conversations = 0;
    const touchedAllocations = new Set<string>();
    for (const conversation of candidates) {
      if (Date.now() >= deadline) break;
      try {
        if (await deleteAgentConversationForPrincipal(
          maintenancePrincipal(conversation),
          conversation.publicId,
        )) conversations += 1;
      } catch {
        await db.agentPublicConversation.updateMany({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        }).catch(() => undefined);
      }
      touchedAllocations.add(conversation.runtimeAllocationId);
    }

    const terminalRunIds = await db.$queryRaw<Array<{ id: string }>>`
      SELECT r."id"
      FROM "AgentRun" r
      JOIN "AgentEndpoint" e ON e."id" = r."endpointId"
      WHERE r."status" IN ('completed', 'failed', 'cancelled')
        AND r."createdAt" < (CAST(${now} AS timestamp) - (e."retentionDays" * INTERVAL '1 day'))
      ORDER BY r."createdAt" ASC
      LIMIT 500
    `;
    const deletedRuns = terminalRunIds.length
      ? await db.agentRun.deleteMany({ where: { id: { in: terminalRunIds.map((run) => run.id) } } })
      : { count: 0 };

    const staleOperationBefore = new Date(now.getTime() - STALE_RUNTIME_OPERATION_MS);
    const staleProvisioningBefore = new Date(now.getTime() - STALE_RUNTIME_PROVISIONING_MS);
    const emptyAllocations = await db.agentEndpointRuntime.findMany({
      where: {
        conversations: { none: { deletingAt: null } },
        OR: [
          { status: { in: ['ready', 'failed'] } },
          { status: 'provisioning', updatedAt: { lt: staleProvisioningBefore } },
          { status: { in: ['stopping', 'deleting'] }, updatedAt: { lt: staleOperationBefore } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    for (const allocation of emptyAllocations) touchedAllocations.add(allocation.id);
    let runtimes = 0;
    for (const allocationId of [...touchedAllocations].slice(0, 50)) {
      if (Date.now() >= deadline) break;
      if (await cleanupAgentEndpointRuntimeIfUnused(allocationId)) runtimes += 1;
    }

    const usageBuckets = await pruneAgentApiUsageBuckets(now);
    return {
      conversations,
      runs: deletedRuns.count,
      runtimes,
      usageBuckets,
    };
  } finally {
    await release().catch(() => undefined);
  }
}

/** Stop idle containers while preserving their volumes for lazy session resume. */
export async function runAgentApiIdleRuntimeMaintenance(now = new Date()): Promise<number> {
  const release = await acquireMaintenanceLease('idle-runtimes', now, 5 * 60_000);
  if (!release) return 0;
  try {
    const deadline = Date.now() + 2 * 60_000;
    const idleBefore = new Date(now.getTime() - 15 * 60_000);
    const staleOperationBefore = new Date(now.getTime() - STALE_RUNTIME_OPERATION_MS);
    const allocations = await db.agentEndpointRuntime.findMany({
      where: {
        runtimeAgentId: { not: null },
        OR: [
          { status: 'ready', lastUsedAt: { lt: idleBefore } },
          { status: 'stopping', updatedAt: { lt: staleOperationBefore } },
        ],
      },
      orderBy: { lastUsedAt: 'asc' },
      take: 25,
      select: { id: true },
    });
    let stopped = 0;
    for (const allocation of allocations) {
      if (Date.now() >= deadline) break;
      if (await stopAgentEndpointRuntimeIfIdle(allocation.id, idleBefore)) stopped += 1;
    }
    return stopped;
  } finally {
    await release().catch(() => undefined);
  }
}
