import 'server-only';
import { z } from 'zod';
import { TaskNotFoundError, RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { agentRuntimeTokenFromRequest } from '@/lib/agents/runtime-access';
import { parseJson } from '@/lib/agents/public-api/body';
import { withLogContext } from '@/lib/observability/context';
import { sessionActor } from './console-http';
import { A2AHttpError } from './principal';
import { WindowLimiter } from './transport-limits';
import { NativeApprovalRequest, NativeApprovalDecision, checkNativeToolApproval, listNativeToolApprovals, decideNativeToolApproval } from './tool-approvals';
const limiter = new WindowLimiter(180, 4096);
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', vary: 'Cookie, Authorization' } });
function failure(error: unknown) {
  const status = error instanceof A2AHttpError ? error.status : error instanceof TaskNotFoundError ? 404
    : error instanceof RequestMalformedError ? 400 : error instanceof UnsupportedOperationError ? 409 : 500;
  return reply({ error: 'The native approval operation was not authorized or could not be completed.' }, status);
}
export async function handleRuntimeApprovals(req: Request, taskId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (req.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
      if (req.headers.has('origin')) return reply({ error: 'Runtime credential required.' }, 403);
      const token = await agentRuntimeTokenFromRequest(req);
      if (!token || token.a2aTaskId !== taskId || !token.a2aApprovalRequired) return reply({ error: 'Runtime credential required.' }, 401);
      limiter.take(`${taskId}:${token.a2aLeaseToken}`);
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply({ error: 'Expected JSON.' }, 415);
      const parsed = await parseJson(req, NativeApprovalRequest, 20_480);
      if (!parsed.ok) return reply({ error: 'Invalid approval request.' }, parsed.reason === 'too_large' ? 413 : 400);
      return reply(await checkNativeToolApproval(token, parsed.value));
    } catch (error) { return failure(error); }
  });
}
export async function handleConsoleApprovals(req: Request, slug: string, agentId: string) {
  return withLogContext({ suppressPayload: true }, async () => {
    try {
      if (!['GET', 'POST'].includes(req.method)) return reply({ error: 'Method not allowed.' }, 405);
      const ctx = await sessionActor(req, slug, agentId);
      if (req.method === 'GET') {
        const params = new URL(req.url).searchParams;
        if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return reply({ error: 'Invalid query.' }, 400);
        const input = z.object({ rootTaskId: z.string().min(1).max(200), taskId: z.string().min(1).max(200) }).strict().safeParse(Object.fromEntries(params));
        if (!input.success) return reply({ error: 'Invalid query.' }, 400);
        return reply({ approvals: await listNativeToolApprovals(ctx, input.data.rootTaskId, input.data.taskId) });
      }
      if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply({ error: 'Expected JSON.' }, 415);
      const parsed = await parseJson(req, NativeApprovalDecision, 4096);
      if (!parsed.ok) return reply({ error: 'Invalid decision.' }, 400);
      return reply(await decideNativeToolApproval(ctx, parsed.value));
    } catch (error) { return failure(error); }
  });
}
