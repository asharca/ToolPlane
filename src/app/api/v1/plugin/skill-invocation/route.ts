import { z } from 'zod';
import { db } from '@/lib/db';
import { scopeToolkitForToken, json, slug } from '@/lib/plugin/telemetry';

export const runtime = 'nodejs';

const Body = z.object({
  workspaceSlug: slug,
  toolkitSlug: slug,
  skillSlug: slug,
  source: z.enum(['user', 'agent']),
  outcome: z.enum(['success', 'error']),
  errorClass: z.enum(['not_found', 'timeout', 'runtime_error', 'unknown']).optional(),
  client: z.string().max(32).optional(),
});

// The plugin's PostToolUse/PostToolUseFailure hook (matcher "Skill") POSTs here
// each time a synced skill runs. Skills never traverse the MCP gateway, so this
// is the only record of skill usage in observability.
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

  await db.skillInvocation.create({
    data: {
      workspaceId: scope.workspaceId,
      toolkitId: scope.toolkitId,
      skillSlug: body.skillSlug,
      source: body.source,
      outcome: body.outcome,
      errorClass: body.errorClass ?? null,
      client: body.client ?? null,
    },
  });

  return json({ ok: true });
}
