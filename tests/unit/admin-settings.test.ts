// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
} from '@/lib/agents/hermes/archive-limits';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    systemSetting: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}));

import {
  getSystemSettings,
  SYSTEM_SETTINGS_ID,
  updateSystemSettings,
} from '@/lib/admin/settings';

describe('system settings storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the safe archive default until the singleton row exists', async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(getSystemSettings()).resolves.toEqual({
      hermesArchiveMaxUploadMiB: DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: SYSTEM_SETTINGS_ID },
      select: { hermesArchiveMaxUploadMiB: true },
    });
  });

  it('writes a singleton setting and never expands a stale value past the hard cap', async () => {
    mocks.upsert.mockResolvedValue({
      hermesArchiveMaxUploadMiB: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });

    await expect(updateSystemSettings(999)).resolves.toEqual({
      hermesArchiveMaxUploadMiB: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { id: SYSTEM_SETTINGS_ID },
      create: {
        id: SYSTEM_SETTINGS_ID,
        hermesArchiveMaxUploadMiB: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
      },
      update: { hermesArchiveMaxUploadMiB: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB },
      select: { hermesArchiveMaxUploadMiB: true },
    });
  });
});
