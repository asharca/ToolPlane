import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  HERMES_ARCHIVE_ABSOLUTE_MAX_UNPACKED_BYTES,
  HERMES_ARCHIVE_BYTES_PER_MIB,
  HERMES_ARCHIVE_IMPORT_MAX_DURATION_SECONDS,
  hermesArchiveMaxUploadBytes,
  hermesArchiveMaxUnpackedBytes,
  isValidHermesArchiveMaxUploadMiB,
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  normalizeHermesArchiveMaxUploadMiB,
} from '@/lib/agents/hermes/archive-limits';

describe('Hermes archive upload limits', () => {
  it('uses a safe default and clamps stale persisted values to the static envelope', () => {
    expect(normalizeHermesArchiveMaxUploadMiB(undefined))
      .toBe(DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB);
    expect(normalizeHermesArchiveMaxUploadMiB(0))
      .toBe(MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB);
    expect(normalizeHermesArchiveMaxUploadMiB(999))
      .toBe(999);
    expect(normalizeHermesArchiveMaxUploadMiB(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB + 1))
      .toBe(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB);
    expect(hermesArchiveMaxUploadBytes(17)).toBe(17 * HERMES_ARCHIVE_BYTES_PER_MIB);
    expect(hermesArchiveMaxUploadBytes(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB))
      .toBe(10 * 1024 * 1024 * 1024);
    expect(hermesArchiveMaxUnpackedBytes(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB))
      .toBe(HERMES_ARCHIVE_ABSOLUTE_MAX_UNPACKED_BYTES);
    expect(HERMES_ARCHIVE_IMPORT_MAX_DURATION_SECONDS).toBe(14 * 60 * 60);
  });

  it('accepts only whole MiB values within the administrator-configurable range', () => {
    expect(isValidHermesArchiveMaxUploadMiB(MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB)).toBe(true);
    expect(isValidHermesArchiveMaxUploadMiB(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB)).toBe(true);
    expect(isValidHermesArchiveMaxUploadMiB(17.5)).toBe(false);
    expect(isValidHermesArchiveMaxUploadMiB(MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB + 1)).toBe(false);
  });
});
