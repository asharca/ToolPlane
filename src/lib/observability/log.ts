import 'server-only';
import { db } from '@/lib/db';
import { formatInTimeZone } from '@/lib/timezone';
import { deploymentLabel } from '@/lib/workspace/deployment-label';

export async function logRequest(entry: {
  workspaceId: string;
  deploymentId?: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody?: string | null;
  responseBody?: string | null;
}): Promise<void> {
  try {
    await db.requestLog.create({ data: entry });
  } catch {
    // never let logging break a request
  }
}

export async function getDeploymentLogs(deploymentId: string, limit = 100) {
  return db.requestLog.findMany({
    where: { deploymentId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      method: true,
      path: true,
      statusCode: true,
      durationMs: true,
      requestBody: true,
      responseBody: true,
      createdAt: true,
    },
  });
}

export type HourBucket = { hour: string; total: number; errors: number };

export type ObservabilityLog = {
  id: string;
  deploymentId: string | null;
  deploymentName: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string | null;
  createdAt: Date;
};

export type DeploymentUsage = {
  id: string | null;
  name: string;
  total: number;
  errors: number;
  avgMs: number;
};

const HOUR_MS = 60 * 60 * 1000;
const RECENT_LOG_LIMIT = 50;

export async function getObservability(
  workspaceId: string,
  timeZone: string,
  hours = 24,
  deploymentId?: string,
) {
  const now = new Date();
  const since = new Date(now.getTime() - hours * HOUR_MS);
  const [logs, deploymentRows] = await Promise.all([
    db.requestLog.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since },
        ...(deploymentId ? { deploymentId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deploymentId: true,
        method: true,
        path: true,
        statusCode: true,
        durationMs: true,
        createdAt: true,
      },
    }),
    db.deployment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        serverId: true,
        name: true,
        source: true,
        sourceRef: true,
        server: { select: { name: true } },
      },
    }),
  ]);

  const recentIds = logs.slice(0, RECENT_LOG_LIMIT).map((log) => log.id);
  const recentDetails = recentIds.length
    ? await db.requestLog.findMany({
        where: { id: { in: recentIds } },
        select: { id: true, requestBody: true, responseBody: true },
      })
    : [];
  const detailById = new Map(recentDetails.map((log) => [log.id, log]));
  const deploymentNames = new Map(
    deploymentRows.map((deployment) => [
      deployment.id,
      deploymentLabel(deployment).name,
    ]),
  );

  const total = logs.length;
  const errors = logs.filter((l) => l.statusCode >= 400).length;
  const avgMs =
    total === 0
      ? 0
      : Math.round(logs.reduce((a, l) => a + l.durationMs, 0) / total);

  const buckets = new Map<number, { total: number; errors: number }>();
  const lastBucket = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const firstBucket = lastBucket - Math.max(0, hours - 1) * HOUR_MS;
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += HOUR_MS) {
    buckets.set(bucket, { total: 0, errors: 0 });
  }
  for (const l of logs) {
    const bucket = buckets.get(Math.floor(l.createdAt.getTime() / HOUR_MS) * HOUR_MS);
    if (bucket) {
      bucket.total += 1;
      if (l.statusCode >= 400) bucket.errors += 1;
    }
  }
  const series: HourBucket[] = [...buckets.entries()].map(([t, v]) => ({
    hour: formatInTimeZone(t, timeZone, { hour: 'numeric' }, 'en-US'),
    total: v.total,
    errors: v.errors,
  }));

  const sortedMs = logs.map((l) => l.durationMs).sort((a, b) => a - b);
  const p95Ms =
    total === 0 ? 0 : sortedMs[Math.min(total - 1, Math.ceil(total * 0.95) - 1)];

  const usage = new Map<string | null, { total: number; errors: number; durationMs: number }>();
  for (const log of logs) {
    const current = usage.get(log.deploymentId) ?? { total: 0, errors: 0, durationMs: 0 };
    current.total += 1;
    current.durationMs += log.durationMs;
    if (log.statusCode >= 400) current.errors += 1;
    usage.set(log.deploymentId, current);
  }
  const deploymentUsage: DeploymentUsage[] = deploymentRows
    .filter((deployment) => !deploymentId || deployment.id === deploymentId)
    .map((deployment) => {
      const value = usage.get(deployment.id) ?? { total: 0, errors: 0, durationMs: 0 };
      return {
        id: deployment.id,
        name: deploymentNames.get(deployment.id) ?? 'Untitled server',
        total: value.total,
        errors: value.errors,
        avgMs: value.total ? Math.round(value.durationMs / value.total) : 0,
      };
    });
  const workspaceApiUsage = usage.get(null);
  if (workspaceApiUsage) {
    deploymentUsage.push({
      id: null,
      name: 'Workspace API',
      total: workspaceApiUsage.total,
      errors: workspaceApiUsage.errors,
      avgMs: Math.round(workspaceApiUsage.durationMs / workspaceApiUsage.total),
    });
  }

  const recent: ObservabilityLog[] = logs.slice(0, RECENT_LOG_LIMIT).map((log) => {
    const details = detailById.get(log.id);
    return {
      ...log,
      deploymentName: log.deploymentId
        ? deploymentNames.get(log.deploymentId) ?? 'Unknown deployment'
        : 'Workspace API',
      requestBody: details?.requestBody ?? null,
      responseBody: details?.responseBody ?? null,
    };
  });

  return {
    total,
    errors,
    avgMs,
    p95Ms,
    series,
    recent,
    deployments: deploymentRows.map((deployment) => ({
      id: deployment.id,
      name: deploymentNames.get(deployment.id) ?? 'Untitled server',
    })),
    deploymentUsage,
    selectedDeployment: deploymentId
      ? deploymentNames.get(deploymentId) ?? 'Unknown deployment'
      : null,
  };
}
