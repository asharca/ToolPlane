// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allowPasswordResetRequest,
  authClientAddress,
  resetAuthRateLimitsForTests,
  takeAuthRateLimit,
} from '@/lib/auth/request-rate-limit';

describe('auth request rate limiting', () => {
  beforeEach(() => resetAuthRateLimitsForTests());
  afterEach(() => vi.unstubAllEnvs());

  it('resets fixed-window buckets after their deadline', () => {
    expect(takeAuthRateLimit('test', 2, 1_000, 0)).toBe(true);
    expect(takeAuthRateLimit('test', 2, 1_000, 1)).toBe(true);
    expect(takeAuthRateLimit('test', 2, 1_000, 2)).toBe(false);
    expect(takeAuthRateLimit('test', 2, 1_000, 1_000)).toBe(true);
  });

  it('uses the first proxy address and limits repeated reset bursts per account', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1' });
    expect(authClientAddress(headers)).toBe('203.0.113.4');
    for (let index = 0; index < 3; index += 1) {
      expect(allowPasswordResetRequest(headers, 'person@example.com')).toBe(true);
    }
    expect(allowPasswordResetRequest(headers, 'person@example.com')).toBe(false);
  });

  it('short-circuits narrow account denials before consuming the global bucket', () => {
    vi.stubEnv('TOOLPLANE_PASSWORD_RESET_GLOBAL_LIMIT', '1');
    const blockedEmail = 'blocked@example.com';
    const digest = createHash('sha256').update(blockedEmail).digest('hex');
    for (let index = 0; index < 3; index += 1) {
      expect(takeAuthRateLimit(`password-reset:account:${digest}`, 3, 600_000)).toBe(true);
    }
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.4' });
    expect(allowPasswordResetRequest(headers, blockedEmail)).toBe(false);
    expect(allowPasswordResetRequest(headers, 'allowed@example.com')).toBe(true);
  });
});
