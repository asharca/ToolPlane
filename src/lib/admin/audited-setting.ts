import 'server-only';
import { db } from '@/lib/db';
import { writeAudit } from '@/lib/observability/audit';

export async function saveAuditedSetting(key: string, value: string | null, actorId: string) {
  await db.$transaction(async (tx) => {
    const before = await tx.systemSetting.findUnique({ where: { key }, select: { value: true } });
    if (value === null) await tx.systemSetting.deleteMany({ where: { key } });
    else await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    await writeAudit(tx, { actorId, action: value === null ? 'setting.reset' : 'setting.changed', targetType: 'systemSetting', targetId: key,
      changes: { before: before?.value ?? null, after: value } });
  });
}

export async function getSettingChanges(keys: string[]) {
  const changes = await Promise.all(keys.map((targetId) => db.auditEvent.findFirst({
    where: { targetType: 'systemSetting', targetId, outcome: 'success' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, targetId: true, actorId: true, createdAt: true },
  })));
  const users = await db.user.findMany({ where: { id: { in: changes.flatMap((change) => change ? [change.actorId] : []) } }, select: { id: true, name: true, email: true } });
  return new Map(changes.flatMap((change) => {
    if (!change) return [];
    const actor = users.find((user) => user.id === change.actorId);
    return [[change.targetId, { ...change, actor: actor?.name ?? actor?.email ?? change.actorId }] as const];
  }));
}
