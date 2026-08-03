// Hermes archive uploads are handled by a Next Server Action. Keep this
// ceiling below the 64 MiB multipart request limit configured in next.config.ts
// so ordinary form fields and multipart framing always have room.
export const HERMES_ARCHIVE_BYTES_PER_MIB = 1024 * 1024;
export const DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB = 48;
export const MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB = 1;
export const MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB = 60;

export function isValidHermesArchiveMaxUploadMiB(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB
    && value <= MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB;
}

// Settings are persisted in the database, so clamp a legacy or manually
// edited value before it becomes an allocation or upload limit.
export function normalizeHermesArchiveMaxUploadMiB(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB;
  }
  return Math.min(
    MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
    Math.max(MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB, Math.trunc(value)),
  );
}

export function hermesArchiveMaxUploadBytes(maxUploadMiB: unknown): number {
  return normalizeHermesArchiveMaxUploadMiB(maxUploadMiB)
    * HERMES_ARCHIVE_BYTES_PER_MIB;
}
