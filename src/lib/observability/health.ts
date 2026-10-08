import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authorizeLogs } from '@/lib/observability/queries';
import { logHealth } from '@/lib/observability/events';
import { effectiveStatuses } from '@/lib/process/supervisor';

export async function getLogHealth(adminId: string) {
  await authorizeLogs({ adminId });
  const until = new Date();
  const since = new Date(until.getTime() - 15 * 60_000);
  const [domains, deployments] = await Promise.all([
    db.$queryRaw<Array<{ domain: string; total: number; errors: number; denied: number; last: Date }>>(Prisma.sql`
      SELECT domain, count(*)::int AS total,
        count(*) FILTER (WHERE outcome IN ('error', 'timeout') OR level = 'error')::int AS errors,
        count(*) FILTER (WHERE outcome = 'denied')::int AS denied,
        max("createdAt") AS last
      FROM "LogEvent" WHERE "createdAt" >= ${since} AND "createdAt" <= ${until}
      GROUP BY domain`),
    db.deployment.findMany({ select: { id: true, name: true, status: true } }),
  ]);
  const statuses = effectiveStatuses(deployments);
  const abnormal = deployments.flatMap((row) => {
    const status = statuses.get(row.id) ?? row.status;
    return ['failed', 'error'].includes(status) || (['running', 'provisioning'].includes(row.status) && status === 'stopped')
      ? [{ ...row, status }] : [];
  });
  const writer = { failures: logHealth.failures, dropped: logHealth.dropped };
  const errors = domains.reduce((sum, row) => sum + row.errors, 0);
  const state = abnormal.length || errors || writer.failures || writer.dropped ? 'attention'
    : domains.length ? 'observed' : 'unknown';
  return { since, until, domains, abnormal, deploymentCount: deployments.length, writer, state };
}
