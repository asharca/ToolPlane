import 'server-only';
import { createHmac } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { AgentApiPrincipal } from '@/lib/agents/public-api/auth';
import { db } from '@/lib/db';
import { AgentApiError, publicErrorMessage } from '@/lib/agents/public-api/errors';
import { runtimeEnv } from '@/lib/runtime-env';

export type AgentApiRateLimitInput = {
  endpointId: string;
  clientId: string;
  endpointRpm: number;
  clientRpm: number;
  endpointDaily: number;
  clientDaily: number;
};

export type AgentApiRateLimitResult = {
  limit: number;
  remaining: number;
  reset: number;
  headers: Headers;
};

type CounterResult = { count: number };
type CounterClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

function windowStart(nowMs: number, seconds: number): Date {
  const sizeMs = seconds * 1_000;
  return new Date(Math.floor(nowMs / sizeMs) * sizeMs);
}

async function takeCounter(
  client: CounterClient,
  key: string,
  limit: number,
  seconds: number,
  nowMs: number,
): Promise<{ count: number; reset: number } | null> {
  const start = windowStart(nowMs, seconds);
  const expiresAt = new Date(start.getTime() + seconds * 2_000);
  const rows = await client.$queryRaw<CounterResult[]>`
    INSERT INTO "AgentApiUsageBucket" ("key", "windowStart", "windowSeconds", "count", "expiresAt")
    VALUES (${key}, ${start}, ${seconds}, 1, ${expiresAt})
    ON CONFLICT ("key", "windowStart", "windowSeconds") DO UPDATE
    SET "count" = "AgentApiUsageBucket"."count" + 1,
        "expiresAt" = EXCLUDED."expiresAt"
    WHERE "AgentApiUsageBucket"."count" < ${limit}
    RETURNING "count"
  `;
  if (!rows[0]) return null;
  return {
    count: Number(rows[0].count),
    reset: Math.ceil((start.getTime() + seconds * 1_000) / 1_000),
  };
}

/**
 * Uses atomic Postgres counters, so limits remain valid across app workers.
 * All four counters share one transaction. A stricter client bucket can reject
 * without consuming an Endpoint-wide slot and becoming a cross-client DoS.
 */
export async function takeAgentApiRateLimit(
  input: AgentApiRateLimitInput,
): Promise<AgentApiRateLimitResult> {
  const nowMs = Date.now();
  const minuteLimit = Math.min(input.endpointRpm, input.clientRpm);
  const result = await db.$transaction(async (tx) => {
    let remaining = minuteLimit;
    let minuteReset = Math.ceil((nowMs + 60_000) / 1_000);
    for (const [key, limit] of [
      [`endpoint:${input.endpointId}:minute`, input.endpointRpm] as const,
      [`client:${input.clientId}:minute`, input.clientRpm] as const,
    ]) {
      const counter = await takeCounter(tx, key, limit, 60, nowMs);
      if (!counter) throw rateLimitError(nowMs, 60);
      remaining = Math.min(remaining, Math.max(0, limit - counter.count));
      minuteReset = Math.min(minuteReset, counter.reset);
    }

    const daySeconds = 24 * 60 * 60;
    for (const [key, limit] of [
      [`endpoint:${input.endpointId}:day`, input.endpointDaily] as const,
      [`client:${input.clientId}:day`, input.clientDaily] as const,
    ]) {
      if (!await takeCounter(tx, key, limit, daySeconds, nowMs)) {
        throw rateLimitError(nowMs, daySeconds);
      }
    }
    return { remaining, minuteReset };
  });

  const headers = new Headers({
    'ratelimit-limit': String(minuteLimit),
    'ratelimit-remaining': String(result.remaining),
    'ratelimit-reset': String(result.minuteReset),
  });
  return {
    limit: minuteLimit,
    remaining: result.remaining,
    reset: result.minuteReset,
    headers,
  };
}

export function takeAgentApiPrincipalRateLimit(
  principal: AgentApiPrincipal,
): Promise<AgentApiRateLimitResult> {
  return takeAgentApiRateLimit({
    endpointId: principal.endpointId,
    clientId: principal.clientId,
    ...principal.rateBuckets,
  });
}

function rateLimitError(nowMs: number, seconds: number): AgentApiError {
  return new AgentApiError(
    'rate_limit_exceeded',
    publicErrorMessage('rate_limit_exceeded'),
    429,
    Math.max(1, Math.ceil(counterWindowRemaining(nowMs, seconds) / 1_000)),
  );
}

function counterWindowRemaining(nowMs: number, seconds: number): number {
  const start = windowStart(nowMs, seconds).getTime();
  return start + seconds * 1_000 - nowMs;
}

export async function pruneAgentApiUsageBuckets(now = new Date()): Promise<number> {
  const deleted = await db.$queryRaw<Array<{ key: string }>>`
    WITH candidates AS (
      SELECT "key", "windowStart", "windowSeconds"
      FROM "AgentApiUsageBucket"
      WHERE "expiresAt" < ${now}
      ORDER BY "expiresAt" ASC
      LIMIT 1000
    )
    DELETE FROM "AgentApiUsageBucket" bucket
    USING candidates
    WHERE bucket."key" = candidates."key"
      AND bucket."windowStart" = candidates."windowStart"
      AND bucket."windowSeconds" = candidates."windowSeconds"
    RETURNING bucket."key"
  `;
  return deleted.length;
}

function requestAddress(headers: Headers): string | null {
  if (runtimeEnv('AGENT_API_TRUST_PROXY_HEADERS') !== 'true') return null;
  return (headers.get('x-real-ip') || headers.get('x-forwarded-for')?.split(',')[0] || '')
    .trim()
    .slice(0, 128) || null;
}

function addressBucket(request: Pick<Request, 'headers'>): string | null {
  const address = requestAddress(request.headers);
  if (!address) return null;
  const secret = runtimeEnv('AUTH_SECRET');
  if (!secret) throw new Error('AUTH_SECRET environment variable is not set');
  return createHmac('sha256', secret)
    .update('toolplane:agent-api:auth-ip\0')
    .update(address)
    .digest('base64url');
}

/** Cheap, pre-verification admission bound for credential lookup traffic. */
export async function takeAgentApiAuthAttemptLimit(
  request: Pick<Request, 'headers'>,
): Promise<void> {
  const nowMs = Date.now();
  if (!await takeCounter(db, 'auth-attempt:global', 100_000, 60, nowMs)) {
    throw rateLimitError(nowMs, 60);
  }
  const addressHash = addressBucket(request);
  if (addressHash && !await takeCounter(db, `auth-attempt:${addressHash}`, 600, 60, nowMs)) {
    throw rateLimitError(nowMs, 60);
  }
}

/** Bound credential guessing even when no valid Endpoint/client can be found. */
export async function takeAgentApiAuthFailureLimit(request: Pick<Request, 'headers'>): Promise<void> {
  const nowMs = Date.now();
  if (!await takeCounter(db, 'auth-failure:global', 2_000, 60, nowMs)) {
    throw rateLimitError(nowMs, 60);
  }
  const addressHash = addressBucket(request);
  if (addressHash && !await takeCounter(db, `auth-failure:${addressHash}`, 30, 60, nowMs)) {
    throw rateLimitError(nowMs, 60);
  }
}

/** Bound unauthenticated browser preflight lookups before reading Endpoint CORS config. */
export async function takeAgentApiPreflightLimit(request: Pick<Request, 'headers'>): Promise<void> {
  const nowMs = Date.now();
  if (!await takeCounter(db, 'preflight:global', 50_000, 60, nowMs)) {
    throw rateLimitError(nowMs, 60);
  }
  const addressHash = addressBucket(request);
  if (addressHash && !await takeCounter(db, `preflight:${addressHash}`, 300, 60, nowMs)) {
    throw rateLimitError(nowMs, 60);
  }
}
