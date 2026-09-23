import 'server-only';
import { z } from 'zod';
import { db } from '@/lib/db';
import { resolveRequestPrincipal } from '@/lib/auth/request-user';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { withLogContext } from '@/lib/observability/context';
import { newSandboxMcpSecret, ownedSandbox } from './mcp-access';
import { normalizeSandboxMcpTools, SANDBOX_MCP_TOOLS, sandboxMcpExportable } from './mcp-policy';
import { privateJson, readSandboxJson, RequestBodyError } from './http-body';
import { sandboxPublicOrigin } from './oauth-policy';

const CreateToken = z.object({
  name: z.string().trim().min(1).max(80),
  allowedTools: z.array(z.enum(SANDBOX_MCP_TOOLS)).min(1).max(8).optional(),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  acknowledgeExecutionAccess: z.boolean().default(false),
}).strict();

// Browser management uses the normal session and strict same-origin mutations.
// Explicit invalid Bearer credentials never fall back to cookies.
export async function sandboxManagementUser(req: Request) {
  const principal = await resolveRequestPrincipal(req);
  if (!principal || principal.credential === 'toolkit-token') return null;
  const origin = req.headers.get('origin');
  if (principal.credential === 'session' && req.method !== 'GET') {
    try { if (origin !== sandboxPublicOrigin()) return null; } catch { return null; }
  } else if (origin !== null) {
    try { if (origin !== sandboxPublicOrigin()) return null; } catch { return null; }
  }
  return principal.user;
}
export function handleSandboxMcpTokens(req: Request, sandboxId: string, tokenId?: string): Promise<Response> {
  return withLogContext({ suppressPayload: true }, async () => {
    const user = await sandboxManagementUser(req);
    if (!user) return privateJson({ error: 'An account session or personal Bearer credential is required.' }, 401);
    const sandbox = await ownedSandbox(sandboxId, user.id);
    if (!sandbox) return privateJson({ error: 'Sandbox not found.' }, 404);
    if (req.method === 'GET' && !tokenId) {
      const tokens = await db.sandboxMcpToken.findMany({
        where: { sandboxId }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, name: true, prefix: true, allowedTools: true, createdAt: true, expiresAt: true, oauthExpiresAt: true, revokedAt: true },
      });
      return privateJson({ tokens, exportable: sandboxMcpExportable(sandbox.kind), limit: 100 });
    }
    const release = beginWorkspaceOperation(sandbox.workspaceId);
    if (!release) return privateJson({ error: 'Workspace unavailable.' }, 409);
    try {
      if (req.method === 'DELETE' && tokenId) {
        // Any current authorized workspace member can revoke a sandbox grant.
        const result = await db.sandboxMcpToken.updateMany({
          where: { id: tokenId, sandboxId }, data: { revokedAt: new Date() },
        });
        return result.count ? privateJson({ revoked: true }) : privateJson({ error: 'Token not found.' }, 404);
      }
      if (req.method !== 'POST' || tokenId) return privateJson({ error: 'Method not allowed.' }, 405);
      if (!sandboxMcpExportable(sandbox.kind)) {
        return privateJson({ error: 'This sandbox kind is not exportable. Hermes private runtime and legacy host sandboxes remain protected.' }, 409);
      }
      const parsed = CreateToken.safeParse(await readSandboxJson(req));
      if (!parsed.success) return privateJson({ error: 'Invalid token settings.' }, 400);
      const input = parsed.data;
      const allowedTools = normalizeSandboxMcpTools(input.allowedTools);
      if (allowedTools.some((name) => name === 'shell_exec' || name === 'process_exec') && !input.acknowledgeExecutionAccess) {
        return privateJson({ error: 'Execution grants require acknowledgeExecutionAccess=true; commands have the remote/container account permissions, not just file-root access.' }, 400);
      }
      const count = await db.sandboxMcpToken.count({ where: { sandboxId, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (count >= 100) return privateJson({ error: 'Revoke unused tokens before creating more.' }, 409);
      const secret = newSandboxMcpSecret();
      const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
      const token = await db.sandboxMcpToken.create({ data: {
        sandboxId, userId: user.id, name: input.name, tokenHash: secret.tokenHash,
        prefix: secret.prefix, allowedTools, expiresAt,
      }, select: { id: true, name: true, prefix: true, allowedTools: true, expiresAt: true } });
      return privateJson({ ...token, token: secret.token,
        endpoint: `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/mcp`,
        transport: 'streamable-http', notice: 'Save this token now. It will not be returned again.' }, 201);
    } catch (error) {
      return privateJson({ error: 'Sandbox credential operation failed.' }, error instanceof RequestBodyError ? error.status : 500);
    } finally { release(); }
  });
}
