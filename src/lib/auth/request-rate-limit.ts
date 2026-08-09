import 'server-only';
import { createHash } from 'node:crypto';
import { runtimeEnv } from '@/lib/runtime-env';

type RateBucket = { count: number; resetAt: number };

declare global {
  var __toolplaneAuthRateLimits: Map<string, RateBucket> | undefined;
}

const buckets = () => (
  globalThis.__toolplaneAuthRateLimits ??= new Map<string, RateBucket>()
);

export function takeAuthRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const store = buckets();
  if (store.size > 10_000) {
    for (const [candidate, bucket] of store) {
      if (bucket.resetAt <= now) store.delete(candidate);
    }
    if (store.size > 10_000) {
      for (const candidate of store.keys()) {
        store.delete(candidate);
        if (store.size <= 9_000) break;
      }
    }
  }

  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function firstHeader(headers: Pick<Headers, 'get'>, name: string): string | null {
  return headers.get(name)?.split(',')[0]?.trim() || null;
}

export function authClientAddress(headers: Pick<Headers, 'get'>): string | null {
  return firstHeader(headers, 'cf-connecting-ip')
    ?? firstHeader(headers, 'x-real-ip')
    ?? firstHeader(headers, 'x-forwarded-for');
}

export function allowPasswordResetRequest(
  headers: Pick<Headers, 'get'>,
  email: string,
): boolean {
  const tenMinutes = 10 * 60_000;
  const configuredGlobalLimit = Number(
    runtimeEnv('TOOLPLANE_PASSWORD_RESET_GLOBAL_LIMIT') ?? 200,
  );
  const globalLimit = Number.isSafeInteger(configuredGlobalLimit) && configuredGlobalLimit > 0
    ? configuredGlobalLimit
    : 200;
  const emailKey = createHash('sha256').update(email).digest('hex');
  const address = authClientAddress(headers);
  if (!takeAuthRateLimit(`password-reset:account:${emailKey}`, 3, tenMinutes)) return false;
  if (address && !takeAuthRateLimit(`password-reset:ip:${address}`, 10, tenMinutes)) return false;
  return takeAuthRateLimit('password-reset:global', globalLimit, tenMinutes);
}

export function resetAuthRateLimitsForTests(): void {
  buckets().clear();
}
