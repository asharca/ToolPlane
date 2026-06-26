import { z } from 'zod';
import { db } from '@/lib/db';
import { scopeToolkitForToken, json, slug } from '@/lib/plugin/telemetry';

export const runtime = 'nodejs';

const count = z.number().int().min(0).max(100000);

const Body = z.object({
  workspaceSlug: slug,
  toolkitSlug: slug,
  added: count,
  removed: count,
  updated: count,
  total: count,
  client: z.string().max(32).optional(),
});

// The plugin's SessionStart sync hook POSTs the delta of each successful skill
// sync here (how many SKILL.md files it added / updated / pruned).
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
      outcome: 'applied',
      added: body.added,
      removed: body.removed,
      updated: body.updated,
      total: body.total,
      client: body.client ?? null,
    },
  });

  return json({ ok: true });
}
