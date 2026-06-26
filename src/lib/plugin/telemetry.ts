import 'server-only';
import { z } from 'zod';
import { verifyApiToken } from '@/lib/auth/tokens';
import { db } from '@/lib/db';

// Slugs are lowercase, 2+ chars, dash-separated — same shape the install/sync
// scripts validate before they ever POST, so anything else is malformed.
export const SLUG = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const slug = z.string().regex(SLUG);

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

type Scope =
  | { ok: true; workspaceId: string; toolkitId: string }
  | { ok: false; status: number; error: string };

// Shared auth + workspace-scoping for the plugin telemetry endpoints. Verifies
// the Bearer token, then resolves the toolkit ONLY if it belongs to a workspace
// the caller owns or is a member of — a non-member token gets 404, never another
// workspace's toolkit (the workspace-scoping security invariant).
export async function scopeToolkitForToken(
  authHeader: string | null,
  workspaceSlug: string,
  toolkitSlug: string,
): Promise<Scope> {
  const user = await verifyApiToken(authHeader);
  if (!user) return { ok: false, status: 401, error: 'unauthorized' };

  const toolkit = await db.toolkit.findFirst({
    where: {
      slug: toolkitSlug,
      workspace: {
        slug: workspaceSlug,
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
    },
    select: { id: true, workspaceId: true },
  });
  if (!toolkit) return { ok: false, status: 404, error: 'toolkit not found' };

  return { ok: true, workspaceId: toolkit.workspaceId, toolkitId: toolkit.id };
}
