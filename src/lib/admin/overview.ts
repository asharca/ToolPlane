import 'server-only';
import { db } from '@/lib/db';
import { aggregateLogs, getA2aMetadata, logFilterSchema, logWhere } from '@/lib/observability/queries';
import { effectiveStatuses } from '@/lib/process/supervisor';

export async function getSystemOverview() {
  const now = new Date(Date.now());
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const mcpFilters = logFilterSchema.parse({ domain: 'mcp', eventName: 'gateway.request', since: since24h, until: now });
  const a2aFilters = logFilterSchema.parse({ domain: 'a2a', eventName: 'a2a.request', direction: 'inbound', since: since24h, until: now });

  const [
    users, admins, suspended, newUsers7d,
    workspaces, memberships, agents, toolkits, installedSkills, providers,
    servers, skills, clients, agentListings, categories,
    deploymentRows, logs, recentUsers, pendingMarket, pendingAgents, recentFailures, unavailableWorkspaces,
    a2aRequests, requestRows,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { role: 'admin' } }),
    db.user.count({ where: { status: 'suspended' } }),
    db.user.count({ where: { createdAt: { gte: since7d } } }),
    db.workspace.count(),
    db.membership.count(),
    db.agent.count(),
    db.toolkit.count(),
    db.installedSkill.count(),
    db.modelProvider.count(),
    db.server.count(),
    db.skill.count(),
    db.client.count(),
    db.agentListing.count(),
    db.category.count(),
    db.deployment.findMany({ select: { id: true, name: true, status: true, workspaceId: true, workspace: { select: { name: true } } } }),
    aggregateLogs(mcpFilters),
    db.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, email: true, name: true, role: true, status: true, createdAt: true },
    }),
    db.marketListing.count({ where: { pendingRelease: { is: { reviewStatus: 'pending' } } } }),
    db.agentListing.count({ where: { pendingRelease: { is: { reviewStatus: 'pending' } } } }),
    db.logEvent.findMany({ where: { createdAt: { gte: since24h }, outcome: { in: ['error', 'timeout'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8,
      select: { id: true, message: true, eventName: true, createdAt: true, domain: true, outcome: true, workspaceId: true } }),
    db.workspace.count({ where: { status: 'delete_failed' } }),
    aggregateLogs(a2aFilters),
    db.logEvent.findMany({
      where: { OR: [logWhere(mcpFilters), logWhere(a2aFilters)] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8,
      select: { id: true, createdAt: true, domain: true, rpcMethod: true, toolName: true, eventName: true,
        actorId: true, outcome: true, durationMs: true, attributes: true },
    }),
  ]);

  const { total, errors, avgMs, p95Ms } = logs;
  const actors = await db.user.findMany({
    where: { id: { in: requestRows.flatMap(row => row.actorId ? [row.actorId] : []) } },
    select: { id: true, name: true },
  });
  const actorNames = new Map(actors.map(actor => [actor.id, actor.name]));
  const recentRequests = requestRows.map(({ attributes, ...row }) => ({
    ...row,
    actorName: row.actorId ? actorNames.get(row.actorId) ?? null : null,
    clientId: getA2aMetadata(attributes)?.clientId ?? null,
  }));

  const deployments: Record<string, number> = {};
  const statuses = effectiveStatuses(deploymentRows);
  const abnormalDeployments = deploymentRows.flatMap((row) => {
    const status = statuses.get(row.id) ?? row.status;
    deployments[status] = (deployments[status] ?? 0) + 1;
    return ['failed', 'error'].includes(status) || (['running', 'provisioning'].includes(row.status) && status === 'stopped')
      ? [{ ...row, status }] : [];
  });

  return {
    counts: {
      users, admins, suspended, newUsers7d,
      workspaces, memberships, agents, toolkits, installedSkills, providers,
      servers, skills, clients, agentListings, categories, deployments,
    },
    requests: { total, errors, avgMs, p95Ms },
    a2aRequests,
    recentRequests,
    recentUsers,
    attention: { pendingReviews: pendingMarket + pendingAgents, abnormalCount: abnormalDeployments.length,
      abnormalDeployments: abnormalDeployments.slice(0, 8), recentFailures, unavailableWorkspaces },
  };
}
