import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorizeLogs } from "@/lib/observability/queries";
import { logHealth } from "@/lib/observability/events";
import { effectiveStatuses } from "@/lib/process/supervisor";

export type LogHealthSnapshot = {
  since: Date;
  until: Date;
  domains: Array<{
    domain: string;
    total: number;
    errors: number;
    denied: number;
    last: Date;
  }>;
  abnormal: Array<{ id: string; name: string | null; status: string }>;
  deploymentCount: number;
  writer: {
    failures: number;
    dropped: number;
    pending: number;
    lastSuccess: string | null;
    stderrDropped: number;
  };
  state: "attention" | "observed" | "unknown";
};

export async function getLogHealth(
  adminId: string,
): Promise<LogHealthSnapshot> {
  await authorizeLogs({ adminId });
  const until = new Date();
  const since = new Date(until.getTime() - 15 * 60_000);
  const [domains, deployments] = await Promise.all([
    db.$queryRaw<LogHealthSnapshot["domains"]>(Prisma.sql`
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
    return ["failed", "error"].includes(status) ||
      (["running", "provisioning"].includes(row.status) && status === "stopped")
      ? [{ ...row, status }]
      : [];
  });
  const writer = {
    failures: logHealth.failures,
    dropped: logHealth.dropped,
    pending: logHealth.pending,
    lastSuccess: logHealth.lastSuccess,
    stderrDropped: logHealth.stderrDropped ?? 0,
  };
  const errors = domains.reduce((sum, row) => sum + row.errors, 0);
  const state =
    abnormal.length ||
    errors ||
    writer.failures ||
    writer.dropped ||
    writer.stderrDropped
      ? "attention"
      : domains.length
        ? "observed"
        : "unknown";
  return {
    since,
    until,
    domains,
    abnormal,
    deploymentCount: deployments.length,
    writer,
    state,
  };
}
