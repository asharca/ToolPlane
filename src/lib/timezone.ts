export const AUTO_TIME_ZONE_VALUE = '__auto__';
export const DEFAULT_TIME_ZONE = 'UTC';

const MAX_TIME_ZONE_LENGTH = 100;

export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_TIME_ZONE_LENGTH) return null;
  if (/^[+-]\d/.test(candidate)) return null;

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate })
      .resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

export function resolveTimeZone(value: string | null | undefined): string {
  return normalizeTimeZone(value) ?? DEFAULT_TIME_ZONE;
}

export function resolveUserTimeZone(user: {
  detectedTimeZone?: string | null;
  timeZoneOverride?: string | null;
}): string {
  return resolveTimeZone(user.timeZoneOverride ?? user.detectedTimeZone);
}

export function detectClientTimeZone(): string | null {
  if (typeof window === 'undefined') return null;
  return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export function listSupportedTimeZones(
  additional: Array<string | null | undefined> = [],
): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [];
  const normalizedAdditional = additional.flatMap((value) => {
    const normalized = normalizeTimeZone(value);
    return normalized ? [normalized] : [];
  });

  return Array.from(
    new Set([DEFAULT_TIME_ZONE, ...supported, ...normalizedAdditional]),
  ).sort((a, b) => a.localeCompare(b));
}

export function formatInTimeZone(
  value: Date | number | string,
  timeZone: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  locales: string | string[] = 'en-US',
): string {
  return new Intl.DateTimeFormat(locales, {
    ...options,
    timeZone: resolveTimeZone(timeZone),
  }).format(new Date(value));
}
