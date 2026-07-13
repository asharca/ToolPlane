// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_ZONE,
  formatInTimeZone,
  normalizeTimeZone,
  resolveUserTimeZone,
} from '@/lib/timezone';

describe('timezone utilities', () => {
  it('normalizes supported IANA timezone names and rejects invalid input', () => {
    expect(normalizeTimeZone('  Asia/Taipei  ')).toBe('Asia/Taipei');
    expect(normalizeTimeZone('Etc/UTC')).toBe('UTC');
    expect(normalizeTimeZone('+08:00')).toBeNull();
    expect(normalizeTimeZone('Not/A-Time-Zone')).toBeNull();
    expect(normalizeTimeZone('')).toBeNull();
    expect(normalizeTimeZone(null)).toBeNull();
  });

  it('resolves manual override before detected timezone and UTC fallback', () => {
    expect(resolveUserTimeZone({
      detectedTimeZone: 'Asia/Taipei',
      timeZoneOverride: 'America/New_York',
    })).toBe('America/New_York');
    expect(resolveUserTimeZone({
      detectedTimeZone: 'Asia/Taipei',
      timeZoneOverride: null,
    })).toBe('Asia/Taipei');
    expect(resolveUserTimeZone({
      detectedTimeZone: null,
      timeZoneOverride: null,
    })).toBe(DEFAULT_TIME_ZONE);
  });

  it('formats the same instant on the correct calendar day across timezones', () => {
    const instant = '2026-01-01T00:30:00.000Z';
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    };

    expect(formatInTimeZone(
      instant,
      'America/Los_Angeles',
      options,
      'en-US',
    )).toBe('Dec 31, 2025');
    expect(formatInTimeZone(
      instant,
      'Asia/Taipei',
      options,
      'en-US',
    )).toBe('Jan 1, 2026');
  });
});
