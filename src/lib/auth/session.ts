import 'server-only';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { db } from '@/lib/db';
import { secureSessionCookie } from './session-cookie';

const COOKIE_NAME = 'mcp_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET environment variable is not set');
  return new TextEncoder().encode(secret);
}

export async function createSession(userId: string, sessionVersion: number): Promise<void> {
  const token = await new SignJWT({ sub: userId, sv: sessionVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: secureSessionCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.sub !== 'string') return null;
    const tokenVersion = typeof payload.sv === 'number' ? payload.sv : 0;
    const user = await db.user.findUnique({
      where: { id: payload.sub },
      select: { sessionVersion: true, status: true },
    });
    if (!user || user.status !== 'active' || user.sessionVersion !== tokenVersion) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
