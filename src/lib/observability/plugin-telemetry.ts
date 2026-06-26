import 'server-only';
import { db } from '@/lib/db';

export type SkillInvocationRow = {
  id: string;
  skillSlug: string;
  source: string;
  outcome: string;
  errorClass: string | null;
  createdAt: Date;
};

export type SyncEventRow = {
  id: string;
  outcome: string;
  added: number;
  removed: number;
  updated: number;
  total: number;
  reason: string | null;
  createdAt: Date;
};

// Plugin telemetry for the observability "Plugin" tab: skill invocations (the
// only signal of skill usage, since skills bypass the MCP gateway) and sync
// runs. Kept separate from getObservability so skill/sync rows never skew the
// MCP gateway's latency/error aggregates.
export async function getPluginTelemetry(workspaceId: string, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [invocations, syncs] = await Promise.all([
    db.skillInvocation.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        skillSlug: true,
        source: true,
        outcome: true,
        errorClass: true,
        createdAt: true,
      },
    }),
    db.syncEvent.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        outcome: true,
        added: true,
        removed: true,
        updated: true,
        total: true,
        reason: true,
        createdAt: true,
      },
    }),
  ]);

  const skillTotal = invocations.length;
  const skillErrors = invocations.filter((i) => i.outcome === 'error').length;
  const byUser = invocations.filter((i) => i.source === 'user').length;

  const applied = syncs.filter((s) => s.outcome === 'applied').length;
  const failures = syncs.filter((s) => s.outcome === 'failure').length;

  return {
    skill: {
      total: skillTotal,
      errors: skillErrors,
      byUser,
      byAgent: skillTotal - byUser,
      recent: invocations.slice(0, 15) as SkillInvocationRow[],
    },
    sync: {
      applied,
      failures,
      recent: syncs.slice(0, 15) as SyncEventRow[],
    },
  };
}
