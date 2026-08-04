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
  getHermesArchiveSettings,
  HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY,
  updateHermesArchiveSettings,
} from '@/lib/admin/settings';

describe('system settings storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the safe archive default until the generic setting row exists', async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(getHermesArchiveSettings()).resolves.toEqual({
      hermesArchiveMaxUploadMiB: DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
      select: { value: true },
    });
  });

  it('writes a key/value setting and never expands a stale value past the hard cap', async () => {
    mocks.upsert.mockResolvedValue(undefined);

    await expect(updateHermesArchiveSettings(999)).resolves.toEqual({
      hermesArchiveMaxUploadMiB: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY },
      create: {
        key: HERMES_ARCHIVE_MAX_UPLOAD_MIB_SETTING_KEY,
        value: String(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB),
      },
      update: { value: String(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB) },
    });
  });

  it('falls back to the safe default while the shared settings table is unavailable', async () => {
    mocks.findUnique.mockRejectedValue(new Error('relation does not exist'));

    await expect(getHermesArchiveSettings()).resolves.toEqual({
      hermesArchiveMaxUploadMiB: DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    });
  });
});
