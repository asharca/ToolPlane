import 'server-only';
import { db } from '@/lib/db';

export async function getSystemOverview() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    users, admins, suspended, newUsers7d,
    workspaces, memberships, agents, toolkits, installedSkills, providers,
    servers, skills, clients, categories,
    deploymentGroups, logs, scraper, recentUsers,
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
    db.category.count(),
    db.deployment.groupBy({ by: ['status'], _count: { _all: true } }),
    db.requestLog.findMany({
      where: { createdAt: { gte: since24h } },
      select: { statusCode: true, durationMs: true },
    }),
    db.scrapeCheckpoint.findMany({ orderBy: { updatedAt: 'desc' } }),
    db.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, email: true, name: true, role: true, status: true, createdAt: true },
    }),
  ]);

  const total = logs.length;
  const errors = logs.filter((l) => l.statusCode >= 400).length;
  const avgMs = total === 0 ? 0 : Math.round(logs.reduce((a, l) => a + l.durationMs, 0) / total);
  const sortedMs = logs.map((l) => l.durationMs).sort((a, b) => a - b);
  const p95Ms = total === 0 ? 0 : sortedMs[Math.min(total - 1, Math.ceil(total * 0.95) - 1)];

  const deployments: Record<string, number> = {};
  for (const g of deploymentGroups) deployments[g.status] = g._count._all;

  return {
    counts: {
      users, admins, suspended, newUsers7d,
      workspaces, memberships, agents, toolkits, installedSkills, providers,
      servers, skills, clients, categories, deployments,
    },
    requests: { total, errors, avgMs, p95Ms },
    scraper,
    recentUsers,
  };
}
