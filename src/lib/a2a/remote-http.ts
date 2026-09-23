import 'server-only';
import { withLogContext } from '@/lib/observability/context';
import { parseJson } from '@/lib/agents/public-api/body';
import { sessionActor } from './console-http';
import { RemoteAgentAction, remoteRegistryView, mutateRemoteRegistry } from './remote-registry';
import { A2AHttpError } from './principal';
import { RemoteA2AError } from './remote-network';
import { WindowLimiter } from './transport-limits';
const admission = new WindowLimiter(20, 4096);
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', vary: 'Cookie',
} });
/** Management BFF only; credentials never become A2A parameters or runtime tools. */
export async function handleRemoteRegistry(req: Request, slug: string, agentId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (!['GET', 'POST'].includes(req.method)) return reply({ error: 'Method not allowed.' }, 405);
      const ctx = await sessionActor(req, slug, agentId);
      if (req.method === 'GET') return reply(await remoteRegistryView(ctx));
      admission.take(`${ctx.workspaceId}:${ctx.actorId}`);
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply({ error: 'Expected JSON.' }, 415);
      const body = await parseJson(req, RemoteAgentAction, 16_384);
      if (!body.ok) return reply({ error: 'Invalid remote Agent configuration.' }, body.reason === 'too_large' ? 413 : 400);
      return reply({ ok: true, ...await mutateRemoteRegistry(ctx, body.value, req.signal) });
    } catch (error) {
      if (error instanceof A2AHttpError) return reply({ error: error.message }, error.status);
      if (error instanceof RemoteA2AError) return reply({ error: error.message }, 409);
      return reply({ error: 'Remote Agent operation failed. Refresh before retrying.' }, 500);
    }
  });
}
