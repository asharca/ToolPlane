// Hermes archive uploads use a raw-body streaming route rather than a Server
// Action. Keeping the setting in MiB preserves the existing admin setting and
// makes the 10 GiB ceiling an exact, safe JavaScript integer.
export const HERMES_ARCHIVE_BYTES_PER_MIB = 1024 * 1024;
export const DEFAULT_HERMES_ARCHIVE_MAX_UPLOAD_MIB = 48;
export const MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB = 1;
export const MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB = 10 * 1024;

// One raw request body and each of the two Docker copy phases get four hours.
// Large imports are serialized, so the longer budget cannot multiply into an
// unbounded number of concurrent long-running operations.
export const HERMES_ARCHIVE_IMPORT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
// Route Handler duration covers the whole transaction: ingress, ZIP
// inspection, docker cp, the in-container copy/chown, and the first runtime
// sync. Keep enough headroom for all sequential phases, not only the request
// body timeout above.
export const HERMES_ARCHIVE_IMPORT_MAX_DURATION_SECONDS = 50_400;

// ZIP extraction remains independently bounded. The bound grows only when an
// administrator raises the compressed-upload limit, so the default 48 MiB
// setting does not suddenly allow a multi-gigabyte expansion.
export const HERMES_ARCHIVE_BASE_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const HERMES_ARCHIVE_ABSOLUTE_MAX_UNPACKED_BYTES = 10 * 1024 * 1024 * 1024;

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

export function hermesArchiveMaxUnpackedBytes(maxUploadMiB: unknown): number {
  return Math.min(
    HERMES_ARCHIVE_ABSOLUTE_MAX_UNPACKED_BYTES,
    Math.max(HERMES_ARCHIVE_BASE_MAX_UNPACKED_BYTES, hermesArchiveMaxUploadBytes(maxUploadMiB)),
  );
}
