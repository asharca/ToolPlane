import { resolveAccountRequestUser } from '@/lib/auth/request-user';
import { auditWhere, authorizeLogs, logFilterSchema, logWhere, LogAccessError } from '@/lib/observability/queries';
import { db } from '@/lib/db';
import { writeAudit } from '@/lib/observability/audit';

export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try { await authorizeLogs({ adminId: user.id }); } catch (error) {
    if (error instanceof LogAccessError) return Response.json({ error: 'Forbidden' }, { status: 403 });
    throw error;
  }
  const query = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = logFilterSchema.safeParse(query);
  if (!parsed.success) return Response.json({ error: 'Invalid filters' }, { status: 400 });
  const audit = query.tab === 'audit';
  const filters = parsed.data;
  if (!audit && !filters.domain && query.domain !== 'all') filters.domain = query.tab === 'agent' ? 'agent' : query.tab === 'runtime' ? 'runtime' : 'http';
  const rows = audit ? await db.auditEvent.findMany({ where: auditWhere(filters), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1000 })
    : await db.logEvent.findMany({ where: logWhere(filters), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1000 });
  await writeAudit(db, { actorId: user.id, action: 'logging.exported', targetType: audit ? 'auditEvent' : 'logEvent', targetId: 'export',
    changes: { rows: rows.length, since: filters.since, until: filters.until, workspaceId: filters.workspaceId } });
  return new Response(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { headers: {
    'content-type': 'application/x-ndjson', 'content-disposition': 'attachment; filename="toolplane-logs.jsonl"',
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-export-limit': '1000',
  } });
}
