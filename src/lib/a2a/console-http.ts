import 'server-only';
import { db } from '@/lib/db';
import { z } from 'zod';
import { getConsoleTaskTree } from './console-tasks';
import { resolveRequestPrincipal } from '@/lib/auth/request-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { runtimeEnv } from '@/lib/runtime-env';
import { withLogContext } from '@/lib/observability/context';
import { parseJson } from '@/lib/agents/public-api/body';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import { A2AHttpError } from './principal';
import { a2aDeploymentOrigin } from './connection-info';
import { getA2AConsoleView, mutateA2AConsole, A2AConsoleAction, type ConsoleActor } from './console-service';
import { createLocalRootGrant } from './local-policy';
import { handleA2ARpc } from './http';
import { WindowLimiter } from './transport-limits';

const requests = new WindowLimiter(120, 4096);
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', vary: 'Cookie',
} });
function failure(error: unknown) {
  if (error instanceof A2AHttpError) return reply({ error: error.message }, error.status);
  if (error instanceof TaskNotFoundError) return reply({ error: 'Agent unavailable.' }, 404);
  return reply({ error: 'A2A operation failed. Refresh the client list before retrying credential creation.' }, 500);
}
/** A separate same-origin browser BFF, never an auth fallback on the A2A wire endpoint. */
export async function sessionActor(req: Request, slug: string, agentId: string): Promise<ConsoleActor> {
  if (req.headers.has('authorization')) throw new A2AHttpError(401, 'Use the console session, not an API credential.');
  const site = req.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) throw new A2AHttpError(403, 'Same-origin request required.');
  const suppliedOrigin = req.headers.get('origin');
  if (req.method !== 'GET' || suppliedOrigin !== null) {
    let expected: string;
    try { expected = a2aDeploymentOrigin(runtimeEnv('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000'); }
    catch { throw new A2AHttpError(503, 'Configure a valid deployment origin first.'); }
    // Exact origin check: null, missing, comma-separated or path-bearing Origin is rejected.
    if (suppliedOrigin !== expected) throw new A2AHttpError(403, 'Same-origin request required.');
  }
  const principal = await resolveRequestPrincipal(req);
  if (!principal || principal.credential !== 'session') throw new A2AHttpError(401, 'Sign in to the console.');
  const workspace = await getWorkspaceForUser(slug, principal.user.id);
  if (!workspace || workspace.status !== 'active') throw new A2AHttpError(404, 'Workspace unavailable.');
  const active = await db.user.count({ where: { id: principal.user.id, status: 'active' } });
  if (!active) throw new A2AHttpError(401, 'Sign in to the console.');
  requests.take(`${workspace.id}:${principal.user.id}`);
  return { workspaceId: workspace.id, actorId: principal.user.id, agentId, slug: workspace.slug };
}
export async function handleA2AConsole(req: Request, slug: string, agentId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (!['GET', 'POST'].includes(req.method)) return reply({ error: 'Method not allowed.' }, 405);
      const ctx = await sessionActor(req, slug, agentId);
      if (req.method === 'GET') return reply(await getA2AConsoleView(ctx));
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new A2AHttpError(415, 'Expected JSON.');
      const parsed = await parseJson(req, A2AConsoleAction, 4096);
      if (!parsed.ok) throw new A2AHttpError(parsed.reason === 'too_large' ? 413 : 400, 'Invalid A2A console request.');
      const result = await mutateA2AConsole(ctx, parsed.value);
      // Do not let a failing follow-up read hide a successfully issued one-time credential.
      return reply({ ok: true, ...result });
    } catch (error) { return failure(error); }
  });
}
export async function handleA2AConsoleRpc(req: Request, slug: string, agentId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
      const ctx = await sessionActor(req, slug, agentId);
      // No fake Bearer token, conversation or public endpoint. Reuse the native local grant and handler.
      return await handleA2ARpc(req, agentId, async () => ({
        grant: await createLocalRootGrant(ctx.workspaceId, ctx.agentId, ctx.actorId), rateHeaders: new Headers(),
      }));
    } catch (error) { return failure(error); }
  });
}

/** Bounded tree reads reuse the browser session boundary, never a delegated runtime credential. */
export async function handleA2AConsoleTasks(req: Request, slug: string, agentId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);
      const ctx = await sessionActor(req, slug, agentId);
      const query = new URL(req.url).searchParams;
      if ([...query.keys()].some((key) => query.getAll(key).length !== 1)) throw new A2AHttpError(400, 'Invalid task query.');
      const parsed = z.object({ rootTaskId: z.string().min(1).max(200), selectedTaskId: z.string().min(1).max(200).optional(),
        historyLength: z.string().regex(/^(?:[0-9]|[12][0-9]|3[0-2])$/).transform(Number).optional() })
        .strict().safeParse(Object.fromEntries(query));
      if (!parsed.success) throw new A2AHttpError(400, 'Invalid task query.');
      return reply(await getConsoleTaskTree(ctx, parsed.data.rootTaskId, parsed.data.selectedTaskId, parsed.data.historyLength ?? 0));
    } catch (error) { return failure(error); }
  });
}
