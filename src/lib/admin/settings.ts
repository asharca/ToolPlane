import 'server-only';

import { db } from '@/lib/db';
import {
  DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  normalizeHermesArchiveMaxUploadMiB,
} from '@/lib/agents/hermes/archive-limits';

export const SYSTEM_SETTINGS_ID = 'default';

export type SystemSettings = {
  hermesArchiveMaxUploadMiB: number;
};

function toSystemSettings(value?: { hermesArchiveMaxUploadMiB: number } | null): SystemSettings {
  return {
    hermesArchiveMaxUploadMiB: normalizeHermesArchiveMaxUploadMiB(
      value?.hermesArchiveMaxUploadMiB ?? DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    ),
  };
}

// This deliberately reads through to Postgres: an administrator's changed
// limit must be enforced by the very next import, including on another app
// instance.
export async function getSystemSettings(): Promise<SystemSettings> {
  const settings = await db.systemSetting.findUnique({
    where: { id: SYSTEM_SETTINGS_ID },
    select: { hermesArchiveMaxUploadMiB: true },
  });
  return toSystemSettings(settings);
}

export async function updateSystemSettings(
  hermesArchiveMaxUploadMiB: number,
): Promise<SystemSettings> {
  const value = normalizeHermesArchiveMaxUploadMiB(hermesArchiveMaxUploadMiB);
  const settings = await db.systemSetting.upsert({
    where: { id: SYSTEM_SETTINGS_ID },
    create: { id: SYSTEM_SETTINGS_ID, hermesArchiveMaxUploadMiB: value },
    update: { hermesArchiveMaxUploadMiB: value },
    select: { hermesArchiveMaxUploadMiB: true },
  });
  return toSystemSettings(settings);
}
