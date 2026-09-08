import 'server-only';
import { z } from 'zod';
import { db } from '@/lib/db';

export const LOG_SETTINGS_KEY = 'observability.settings';
export const logSettingsSchema = z.object({
  eventDays: z.number().int().min(1).max(365).default(30),
  detailDays: z.number().int().min(1).max(30).default(7),
  auditDays: z.number().int().min(30).max(3650).default(180),
  captures: z.array(z.object({
    field: z.enum(['workspaceId', 'deploymentId', 'agentId']),
    id: z.string().min(1).max(200),
    expiresAt: z.string().datetime(),
  })).max(20).default([]),
});
export type LogSettings = z.infer<typeof logSettingsSchema>;
let cached: { value: LogSettings; until: number } | undefined;
let loading: Promise<LogSettings> | undefined;
export function invalidateLogSettings() { cached = undefined; }
export async function getLogSettings(): Promise<LogSettings> {
  if (cached && cached.until > Date.now()) return cached.value;
  loading ??= (async () => {
    const row = await db.systemSetting.findUnique({ where: { key: LOG_SETTINGS_KEY } });
    let raw: unknown;
    try { raw = JSON.parse(row?.value ?? '{}'); } catch { raw = {}; }
    const parsed = logSettingsSchema.safeParse(raw);
    const value = parsed.success ? parsed.data : logSettingsSchema.parse({});
    cached = { value, until: Date.now() + 10_000 };
    return value;
  })().finally(() => { loading = undefined; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([loading, new Promise<LogSettings>((resolve) => {
      timer = setTimeout(() => resolve(logSettingsSchema.parse({})), 300);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
