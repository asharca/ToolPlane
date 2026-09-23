import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { sandboxMcpExportable } from './mcp-policy';
import { sandboxMcpResource } from './oauth-policy';

export function newSandboxMcpSecret() {
  const token = `mcpsbx_${randomBytes(32).toString('hex')}`;
  return { token, tokenHash: hashSandboxMcpToken(token), prefix: token.slice(0, 15) };
}
export function hashSandboxMcpToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export function sandboxBearer(req: Request): string | null {
  const match = /^Bearer (mcpsbx_[a-f0-9]{64})$/.exec(req.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}
export async function ownedSandbox(sandboxId: string, userId: string) {
  return db.sandbox.findFirst({
    where: { id: sandboxId, workspace: {
      status: 'active', OR: [{ ownerId: userId, owner: { status: 'active' } }, { members: { some: { userId, user: { status: 'active' } } } }],
    } },
    select: { id: true, name: true, kind: true, workspaceId: true, deploymentId: true,
      deployment: { select: { id: true, workspaceId: true, status: true, mcpToolExposure: true, mcpAllowedTools: true } } },
  });
}
export async function resolveSandboxMcpGrant(sandboxId: string, token: string) {
  if (!/^mcpsbx_[a-f0-9]{64}$/.test(token)) return null;
  const grant = await db.sandboxMcpToken.findFirst({
    where: { sandboxId, tokenHash: hashSandboxMcpToken(token), revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, userId: true, allowedTools: true, oauthResource: true },
  });
  if (!grant || (grant.oauthResource && grant.oauthResource !== sandboxMcpResource(sandboxId))) return null;
  const sandbox = await ownedSandbox(sandboxId, grant.userId);
  if (!sandbox || !sandboxMcpExportable(sandbox.kind)) return null;
  return { ...grant, sandbox };
}
