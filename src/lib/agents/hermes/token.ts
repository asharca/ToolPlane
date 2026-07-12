import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type HermesRuntimeTokenPurpose = 'hermes-api' | 'toolplane-mcp';

export type HermesDashboardBrokerAccess = {
  expiresAt: number;
  parentOrigin: string;
};

const DASHBOARD_ACCESS_TTL_SECONDS = 60 * 60 * 8;

function signingSecret(): string {
  const secret = process.env.AUTH_SECRET || (process.env.NODE_ENV === 'test' ? 'test-secret' : '');
  if (!secret) throw new Error('AUTH_SECRET environment variable is not set');
  return secret;
}

export function deriveHermesRuntimeToken(
  runtimeId: string,
  purpose: HermesRuntimeTokenPurpose,
): string {
  const digest = createHmac('sha256', signingSecret())
    .update(`toolplane:agent-runtime:${purpose}:${runtimeId}`)
    .digest('base64url');
  return `tphr_${digest}`;
}

export function verifyHermesRuntimeToken(
  runtimeId: string,
  purpose: HermesRuntimeTokenPurpose,
  token: string,
): boolean {
  const expected = Buffer.from(deriveHermesRuntimeToken(runtimeId, purpose));
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function createHermesDashboardAccessToken(
  runtimeId: string,
  now = Date.now(),
): string {
  const expiresAt = Math.floor(now / 1000) + DASHBOARD_ACCESS_TTL_SECONDS;
  const expiry = expiresAt.toString(36);
  const signature = createHmac('sha256', signingSecret())
    .update(`toolplane:agent-runtime:hermes-dashboard:${runtimeId}:${expiry}`)
    .digest('base64url');
  return `tpdh_${expiry}_${signature}`;
}

export function createHermesDashboardPath(
  runtimeId: string,
  now = Date.now(),
): string {
  const accessToken = createHermesDashboardAccessToken(runtimeId, now);
  return `/api/v1/agent-runtimes/${encodeURIComponent(runtimeId)}/dashboard/${encodeURIComponent(accessToken)}/`;
}

export function verifyHermesDashboardAccessToken(
  runtimeId: string,
  token: string,
  now = Date.now(),
): boolean {
  const match = /^tpdh_([0-9a-z]+)_([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return false;
  const expiresAt = Number.parseInt(match[1], 36);
  const currentTime = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < currentTime) return false;
  if (expiresAt > currentTime + DASHBOARD_ACCESS_TTL_SECONDS + 60) return false;

  const expected = createHmac('sha256', signingSecret())
    .update(`toolplane:agent-runtime:hermes-dashboard:${runtimeId}:${match[1]}`)
    .digest('base64url');
  const received = match[2];
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function normalizedHttpOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createHermesDashboardBrokerAccessToken(
  runtimeId: string,
  parentOrigin: string,
  now = Date.now(),
): string {
  const normalizedOrigin = normalizedHttpOrigin(parentOrigin);
  if (!normalizedOrigin) throw new Error('Hermes dashboard parent origin is invalid.');

  const expiresAt = Math.floor(now / 1000) + DASHBOARD_ACCESS_TTL_SECONDS;
  const expiry = expiresAt.toString(36);
  const encodedOrigin = Buffer.from(normalizedOrigin).toString('base64url');
  const signature = createHmac('sha256', signingSecret())
    .update(`toolplane:agent-runtime:hermes-dashboard-broker:${runtimeId}:${expiry}:${encodedOrigin}`)
    .digest('base64url');
  return `tpdb_${expiry}.${encodedOrigin}.${signature}`;
}

export function verifyHermesDashboardBrokerAccessToken(
  runtimeId: string,
  token: string,
  now = Date.now(),
): HermesDashboardBrokerAccess | null {
  const match = /^tpdb_([0-9a-z]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return null;

  const expiresAt = Number.parseInt(match[1], 36);
  const currentTime = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < currentTime) return null;
  if (expiresAt > currentTime + DASHBOARD_ACCESS_TTL_SECONDS + 60) return null;

  const expected = createHmac('sha256', signingSecret())
    .update(`toolplane:agent-runtime:hermes-dashboard-broker:${runtimeId}:${match[1]}:${match[2]}`)
    .digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(match[3]);
  if (
    expectedBuffer.length !== receivedBuffer.length
    || !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return null;
  }

  let decodedOrigin: string;
  try {
    decodedOrigin = Buffer.from(match[2], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parentOrigin = normalizedHttpOrigin(decodedOrigin);
  if (!parentOrigin || Buffer.from(parentOrigin).toString('base64url') !== match[2]) return null;
  return { expiresAt, parentOrigin };
}
