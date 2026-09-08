import 'server-only';
import { db } from '@/lib/db';
import { aggregateLogs, logFilterSchema } from '@/lib/observability/queries';
import { effectiveStatuses } from '@/lib/process/supervisor';

export async function getSystemOverview() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    users, admins, suspended, newUsers7d,
    workspaces, memberships, agents, toolkits, installedSkills, providers,
    servers, skills, clients, agentListings, categories,
    deploymentRows, logs, recentUsers, pendingMarket, pendingAgents, recentFailures, unavailableWorkspaces,
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
    aggregateLogs(logFilterSchema.parse({ domain: 'mcp', eventName: 'gateway.request', since: since24h })),
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
  ]);

  const { total, errors, avgMs, p95Ms } = logs;

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
    recentUsers,
    attention: { pendingReviews: pendingMarket + pendingAgents, abnormalCount: abnormalDeployments.length,
      abnormalDeployments: abnormalDeployments.slice(0, 8), recentFailures, unavailableWorkspaces },
  };
}
