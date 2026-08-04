import 'server-only';

import { db } from '@/lib/db';
import {
  DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  isValidHermesArchiveMaxUploadMiB,
  normalizeHermesArchiveMaxUploadMiB,
} from '@/lib/agents/hermes/archive-limits';

export const HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY = 'hermes.maxArchiveUploadMiB';

export type SystemSettings = {
  hermesArchiveMaxUploadMiB: number;
};

function toSystemSettings(value?: string | null): SystemSettings {
  const parsed = Number(value);
  return {
    hermesArchiveMaxUploadMiB: isValidHermesArchiveMaxUploadMiB(parsed)
      ? parsed
      : DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  };
}

// This deliberately reads through to Postgres: an administrator's changed
// limit must be enforced by the very next import, including on another app
// instance.
export async function getHermesArchiveSettings(): Promise<SystemSettings> {
  try {
    const settings = await db.systemSetting.findUnique({
      where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
      select: { value: true },
    });
    return toSystemSettings(settings?.value);
  } catch {
    // Keep archive imports available during a rolling deploy before the
    // generic SystemSetting migration has completed.
    return toSystemSettings();
  }
}

export async function updateHermesArchiveSettings(
  hermesArchiveMaxUploadMiB: number,
): Promise<SystemSettings> {
  const value = normalizeHermesArchiveMaxUploadMiB(hermesArchiveMaxUploadMiB);
  await db.systemSetting.upsert({
    where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
    create: {
      key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY,
      value: String(value),
    },
    update: { value: String(value) },
  });
  return toSystemSettings(String(value));
}
