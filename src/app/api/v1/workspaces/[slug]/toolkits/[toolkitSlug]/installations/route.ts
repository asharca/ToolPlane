import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { resolveAccountRequestUser } from '@/lib/auth/request-user';
import { isSameOriginRequest } from '@/lib/http/origin';
import { parseJson } from '@/lib/agents/public-api/body';
import { writeAudit } from '@/lib/observability/audit';

export const runtime = 'nodejs';
type Context = { params: Promise<{ slug: string; toolkitSlug: string }> };
const headers = { 'cache-control': 'private, no-store' };
const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('revoke'), installationId: z.string().min(1).max(128) }).strict(),
  z.object({ operation: z.literal('revoke-all') }).strict(),
  z.object({ operation: z.literal('rotate-link') }).strict(),
]);
async function resolve(req: Request, ctx: Context) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return null;
  const { slug, toolkitSlug } = await ctx.params;
  const toolkit = await db.toolkit.findFirst({ where: { slug: toolkitSlug,
    workspace: { slug, status: 'active', OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
  }, select: { id: true, workspaceId: true } });
  return toolkit ? { user, toolkit } : null;
}
export async function GET(req: Request, ctx: Context) {
  const auth = await resolve(req, ctx);
  if (!auth) return Response.json({ error: 'Not found' }, { status: 404, headers });
  const installations = await db.toolkitInstallation.findMany({
    where: { userId: auth.user.id, toolkitId: auth.toolkit.id }, orderBy: { createdAt: 'desc' }, take: 200,
    select: { id: true, client: true, label: true, status: true, createdAt: true, lastUsedAt: true },
  });
  return Response.json({ installations }, { headers });
}
export async function POST(req: Request, ctx: Context) {
  if ((req.headers.get('origin') && !isSameOriginRequest(req)) || !req.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: 'Invalid origin or content type' }, { status: 403, headers });
  }
  const auth = await resolve(req, ctx);
  if (!auth) return Response.json({ error: 'Not found' }, { status: 404, headers });
  const input = await parseJson(req, Input, 4096);
  if (!input.ok) return Response.json({ error: 'Invalid body' }, { status: 400, headers });
  const value = input.value;
  const result = await db.$transaction(async (tx) => {
    // Same lock order as installation creation and workspace membership changes.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${auth.toolkit.workspaceId} FOR UPDATE`;
    const stillAllowed = await tx.toolkit.findFirst({ where: { id: auth.toolkit.id,
      workspace: { status: 'active', OR: [{ ownerId: auth.user.id }, { members: { some: { userId: auth.user.id } } }] },
    }, select: { id: true } });
    if (!stillAllowed) return false;
    if (value.operation === 'rotate-link') {
      await tx.toolkitInstallLink.deleteMany({ where: { toolkitId: auth.toolkit.id, userId: auth.user.id } });
      await tx.toolkitInstallLink.create({ data: { id: randomBytes(32).toString('base64url'), toolkitId: auth.toolkit.id, userId: auth.user.id } });
    } else {
      const where = { userId: auth.user.id, toolkitId: auth.toolkit.id,
        ...(value.operation === 'revoke' ? { id: value.installationId } : {}) };
      const targets = await tx.toolkitInstallation.findMany({ where, select: { id: true } });
      if (value.operation === 'revoke' && !targets.length) return false;
      await tx.toolkitInstallation.updateMany({ where, data: { status: 'revoked' } });
      await tx.apiToken.updateMany({ where: { userId: auth.user.id, toolkitId: auth.toolkit.id,
        ...(value.operation === 'revoke' ? { installationId: value.installationId } : {}) }, data: { expiresAt: new Date() } });
    }
    await writeAudit(tx, { actorId: auth.user.id, action: `installation.${value.operation}`,
      targetType: 'toolkit', targetId: auth.toolkit.id,
      changes: value.operation === 'revoke' ? { installationId: value.installationId } : {} });
    return true;
  });
  return Response.json(result ? { ok: true } : { error: 'Not found' }, { status: result ? 200 : 404, headers });
}
