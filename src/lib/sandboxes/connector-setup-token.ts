import 'server-only';
import { cookies } from 'next/headers';

const COOKIE_PREFIX = 'toolplane_connector_setup_';
const COOKIE_MAX_AGE_SECONDS = 180;

function cookieName(sandboxId: string): string {
  return `${COOKIE_PREFIX}${sandboxId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export async function setConnectorSetupTokenCookie(
  workspaceSlug: string,
  sandboxId: string,
  token: string,
): Promise<void> {
  const jar = await cookies();
  jar.set(cookieName(sandboxId), token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: `/app/${encodeURIComponent(workspaceSlug)}/sandboxes/${encodeURIComponent(sandboxId)}`,
  });
}

export async function readConnectorSetupTokenCookie(sandboxId: string): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(cookieName(sandboxId))?.value;
}
