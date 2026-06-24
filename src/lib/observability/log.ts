import 'server-only';
import { db } from '@/lib/db';

export async function logRequest(entry: {
  workspaceId: string;
  deploymentId?: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
}): Promise<void> {
  try {
    await db.requestLog.create({ data: entry });
  } catch {
    // never let logging break a request
  }
}

export type HourBucket = { hour: string; total: number; errors: number };

export async function getObservability(workspaceId: string, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const logs = await db.requestLog.findMany({
    where: { workspaceId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      method: true,
      path: true,
      statusCode: true,
      durationMs: true,
      createdAt: true,
    },
  });

  const total = logs.length;
  const errors = logs.filter((l) => l.statusCode >= 400).length;
  const avgMs =
    total === 0
      ? 0
      : Math.round(logs.reduce((a, l) => a + l.durationMs, 0) / total);

  const buckets = new Map<number, { total: number; errors: number }>();
  for (let i = hours - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    buckets.set(d.getTime(), { total: 0, errors: 0 });
  }
  for (const l of logs) {
    const d = new Date(l.createdAt);
    d.setMinutes(0, 0, 0);
    const b = buckets.get(d.getTime());
    if (b) {
      b.total += 1;
      if (l.statusCode >= 400) b.errors += 1;
    }
  }
  const series: HourBucket[] = [...buckets.entries()].map(([t, v]) => ({
    hour: new Date(t).toLocaleTimeString('en-US', { hour: 'numeric' }),
    total: v.total,
    errors: v.errors,
  }));

  const sortedMs = logs.map((l) => l.durationMs).sort((a, b) => a - b);
  const p95Ms =
    total === 0 ? 0 : sortedMs[Math.min(total - 1, Math.ceil(total * 0.95) - 1)];

  return { total, errors, avgMs, p95Ms, series, recent: logs.slice(0, 12) };
}
