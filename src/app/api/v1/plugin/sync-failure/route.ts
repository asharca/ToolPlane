import { z } from 'zod';
import { db } from '@/lib/db';
import { scopeToolkitForToken, json, slug } from '@/lib/plugin/telemetry';

export const runtime = 'nodejs';

const Body = z.object({
  workspaceSlug: slug,
  toolkitSlug: slug,
  reason: z.enum(['fetch_failed', 'invalid_response', 'write_failed', 'unknown']),
  client: z.string().max(32).optional(),
});

// The plugin's SessionStart sync hook POSTs here when a sync run fails (the
// baseline fetch errored, the response was unparseable, or a write failed). The
// client keeps its cached skills; this just surfaces the drop in observability.
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const scope = await scopeToolkitForToken(
    req.headers.get('authorization'),
    body.workspaceSlug,
    body.toolkitSlug,
  );
  if (!scope.ok) return json({ error: scope.error }, scope.status);

  await db.syncEvent.create({
    data: {
      workspaceId: scope.workspaceId,
      toolkitId: scope.toolkitId,
      outcome: 'failure',
      reason: body.reason,
      client: body.client ?? null,
    },
  });

  return json({ ok: true });
}
