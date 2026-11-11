import "server-only";
import { db } from "@/lib/db";
import {
  aggregateLogs,
  authorizeLogs,
  getErrorGroups,
  getA2aMetadata,
  logFilterSchema,
  logWhere,
} from "@/lib/observability/queries";
import { effectiveStatuses } from "@/lib/process/supervisor";

export async function getSystemOverview(adminId: string) {
  await authorizeLogs({ adminId });
  const now = new Date(Date.now());
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const mcpFilters = logFilterSchema.parse({
    domain: "mcp",
    eventName: "gateway.request",
    since: since24h,
    until: now,
  });
  const a2aFilters = logFilterSchema.parse({
    domain: "a2a",
    eventName: "a2a.request",
    direction: "inbound",
    since: since24h,
    until: now,
  });

  const [
    users,
    admins,
    suspended,
    newUsers7d,
    workspaces,
    memberships,
    agents,
    installedSkills,
    providers,
    deploymentGroups,
    deploymentRows,
    logs,
    recentUsers,
    recentFailures,
    unavailableWorkspaces,
    a2aRequests,
    requestRows,
    errorGroups,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { role: "admin" } }),
    db.user.count({ where: { status: "suspended" } }),
    db.user.count({ where: { createdAt: { gte: since7d } } }),
    db.workspace.count(),
    db.membership.count(),
    db.agent.count(),
    db.installedSkill.count(),
    db.modelProvider.count(),
    db.deployment.groupBy({ by: ["status"], _count: { _all: true } }),
    db.deployment.findMany({
      where: { status: { in: ["running", "provisioning", "failed", "error"] } },
      select: {
        id: true,
        name: true,
        status: true,
        workspaceId: true,
        workspace: { select: { name: true } },
      },
    }),
    aggregateLogs(mcpFilters),
    db.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        createdAt: true,
      },
    }),
    db.logEvent.findMany({
      where: {
        createdAt: { gte: since24h },
        outcome: { in: ["error", "timeout"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
      select: {
        id: true,
        message: true,
        eventName: true,
        createdAt: true,
        domain: true,
        outcome: true,
        workspaceId: true,
      },
    }),
    db.workspace.count({ where: { status: "delete_failed" } }),
    aggregateLogs(a2aFilters),
    db.logEvent.findMany({
      where: { OR: [await logWhere(mcpFilters), await logWhere(a2aFilters)] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
      select: {
        id: true,
        createdAt: true,
        domain: true,
        rpcMethod: true,
        toolName: true,
        eventName: true,
        actorId: true,
        outcome: true,
        durationMs: true,
        attributes: true,
      },
    }),
    getErrorGroups({ adminId }, { since: since24h, until: now }),
  ]);

  const { total, errors, avgMs, p95Ms } = logs;
  const actors = await db.user.findMany({
    where: {
      id: {
        in: requestRows.flatMap((row) => (row.actorId ? [row.actorId] : [])),
      },
    },
    select: { id: true, name: true },
  });
  const actorNames = new Map(actors.map((actor) => [actor.id, actor.name]));
  const recentRequests = requestRows.map(({ attributes, ...row }) => ({
    ...row,
    actorName: row.actorId ? (actorNames.get(row.actorId) ?? null) : null,
    clientId: getA2aMetadata(attributes)?.clientId ?? null,
  }));

  const deployments: Record<string, number> = Object.fromEntries(
    deploymentGroups.map((row) => [row.status, row._count._all]),
  );
  const statuses = effectiveStatuses(deploymentRows);
  const abnormalDeployments = deploymentRows.flatMap((row) => {
    const status = statuses.get(row.id) ?? row.status;
    if (status !== row.status) {
      deployments[row.status] -= 1;
      if (deployments[row.status] === 0) delete deployments[row.status];
      deployments[status] = (deployments[status] ?? 0) + 1;
    }
    return ["failed", "error"].includes(status) ||
      (["running", "provisioning"].includes(row.status) && status === "stopped")
      ? [{ ...row, status }]
      : [];
  });

  return {
    counts: {
      users,
      admins,
      suspended,
      newUsers7d,
      workspaces,
      memberships,
      agents,
      installedSkills,
      providers,
      deployments,
    },
    requests: { total, errors, avgMs, p95Ms },
    a2aRequests,
    recentRequests,
    recentUsers,
    errorGroups: errorGroups.slice(0, 5),
    errorGroupsWindow: { since: since24h, until: now },
    attention: {
      abnormalCount: abnormalDeployments.length,
      abnormalDeployments: abnormalDeployments.slice(0, 8),
      recentFailures,
      unavailableWorkspaces,
    },
  };
}
