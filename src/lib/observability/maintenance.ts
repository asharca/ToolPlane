import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getLogSettings } from './settings';

export async function maintainLogs(now = new Date()) {
  const settings = await getLogSettings();
  return db.$transaction(async (tx) => {
    const [lease] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('toolplane:log-retention')) AS locked`;
    if (!lease.locked) return 0;
    let removed = 0;
    for (const [table, key, column, before] of [
      ['LogDetail', 'eventId', 'expiresAt', now],
      ['LogEvent', 'id', 'createdAt', new Date(now.getTime() - settings.eventDays * 86_400_000)],
      ['AuditEvent', 'id', 'createdAt', new Date(now.getTime() - settings.auditDays * 86_400_000)],
    ] as const) {
      for (let batch = 0; batch < 10; batch++) {
        const count = await tx.$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(`"${table}"`)}
          WHERE ${Prisma.raw(`"${key}"`)} IN (SELECT ${Prisma.raw(`"${key}"`)} FROM ${Prisma.raw(`"${table}"`)}
          WHERE ${Prisma.raw(`"${column}"`)} < ${before} ORDER BY ${Prisma.raw(`"${column}"`)} LIMIT 1000)`);
        removed += count;
        if (count < 1000) break;
      }
    }
    return removed;
  }, { timeout: 15_000 });
}
