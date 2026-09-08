'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/db';
import { writeAudit } from '@/lib/observability/audit';
import { LOG_SETTINGS_KEY, logSettingsSchema, invalidateLogSettings } from '@/lib/observability/settings';

export async function updateLogSettings(_previous: { ok?: boolean; error?: string }, form: FormData): Promise<{ ok?: boolean; error?: string }> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const intent = form.get('intent');
  try {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${LOG_SETTINGS_KEY}))::text`;
    const row = await tx.systemSetting.findUnique({ where: { key: LOG_SETTINGS_KEY } });
    const before = logSettingsSchema.parse(JSON.parse(row?.value ?? '{}'));
    const after = { ...before, captures: before.captures.filter((item) => new Date(item.expiresAt).getTime() > Date.now()) };
    if (intent === 'retention') {
      Object.assign(after, { eventDays: Number(form.get('eventDays')), detailDays: Number(form.get('detailDays')), auditDays: Number(form.get('auditDays')) });
    } else if (intent === 'capture') {
      const field = String(form.get('field'));
      const id = String(form.get('id') ?? '').trim();
      const exists = field === 'workspaceId' ? await tx.workspace.findUnique({ where: { id }, select: { id: true } })
        : field === 'deploymentId' ? await tx.deployment.findUnique({ where: { id }, select: { id: true } })
        : field === 'agentId' ? await tx.agent.findUnique({ where: { id }, select: { id: true } }) : null;
      if (!exists) throw new Error('Resource not found');
      after.captures = [...after.captures.filter((item) => item.field !== field || item.id !== id), {
        field: field as 'workspaceId' | 'deploymentId' | 'agentId', id, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }];
    } else if (intent === 'stop') after.captures = [];
    else throw new Error('Invalid operation');
    const value = JSON.stringify(logSettingsSchema.parse(after));
    await tx.systemSetting.upsert({ where: { key: LOG_SETTINGS_KEY }, create: { key: LOG_SETTINGS_KEY, value }, update: { value } });
    await writeAudit(tx, { actorId: admin.id, action: `logging.${intent}`, targetType: 'systemSetting', targetId: LOG_SETTINGS_KEY, changes: { before, after } });
  });
  } catch {
    return { error: t('logsSettingsError') };
  }
  invalidateLogSettings();
  revalidatePath('/admin/logs');
  return { ok: true };
}
