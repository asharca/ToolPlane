import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { startProcess } from '@/lib/process/supervisor';
import { resolveSpawnSpec } from '@/lib/process/spawn-spec';
import { assertRuntimeOwner } from '@/lib/runtime/ownership-state';
import { beginWorkspaceOperation } from '@/lib/workspace/operation-gate';
import { withLogContext } from '@/lib/observability/context';
import { listSshTargetsForWorkspace, resolveSshTargetForWorkspace } from './ssh-targets';
import { sandboxManagementUser } from './mcp-management';
import { privateJson, readSandboxJson, RequestBodyError } from './http-body';
const Create = z.object({
  name: z.string().trim().min(1).max(80),
  targetId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  acknowledgeHostAccess: z.literal(true),
}).strict();
export function handleSshSandboxes(req: Request, workspaceId: string): Promise<Response> {
  return withLogContext({ suppressPayload: true }, async () => {
    const user = await sandboxManagementUser(req);
    if (!user) return privateJson({ error: 'An account session or personal Bearer credential is required.' }, 401);
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, status: 'active', OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
      select: { id: true, slug: true },
    });
    if (!workspace) return privateJson({ error: 'Workspace not found.' }, 404);
    const release = beginWorkspaceOperation(workspaceId);
    if (!release) return privateJson({ error: 'Workspace unavailable.' }, 409);
    try {
      if (req.method === 'GET') return privateJson({ targets: listSshTargetsForWorkspace(workspaceId) });
      if (req.method !== 'POST') return privateJson({ error: 'Method not allowed.' }, 405);
      const parsed = Create.safeParse(await readSandboxJson(req));
      if (!parsed.success) return privateJson({ error: 'A name, approved targetId and acknowledgeHostAccess=true are required.' }, 400);
      const input = parsed.data;
      resolveSshTargetForWorkspace(input.targetId, workspaceId);
      assertRuntimeOwner();
      const id = randomUUID();
      const deploymentId = randomUUID();
      const deployment = await db.$transaction(async (tx) => {
        const row = await tx.deployment.create({ data: {
          id: deploymentId, workspaceId, name: `Sandbox: ${input.name}`, serverId: null,
          source: 'sandbox', sourceRef: `ssh-target:${input.targetId}`, status: 'provisioning',
          installCfg: { sandboxId: id, kind: 'ssh', sshTargetId: input.targetId, env: {}, network: 'isolated' },
        } });
        await tx.sandbox.create({ data: {
          id, workspaceId, deploymentId, name: input.name, slug: `ssh-${id}`,
          kind: 'ssh', image: null, network: 'isolated', config: { sshTargetId: input.targetId, env: {} },
        } });
        return row;
      });
      try { await startProcess(deploymentId, resolveSpawnSpec(deployment), { awaitReady: false, workspaceId }); }
      catch {
        await db.deployment.updateMany({ where: { id: deploymentId, workspaceId }, data: { status: 'error' } });
        return privateJson({ id, deploymentId, status: 'error', error: 'Record created, but SSH startup failed. Fix the approved target and retry Start; do not create a duplicate.' }, 201);
      }
      return privateJson({ id, deploymentId, status: 'provisioning',
        consolePath: `/app/${workspace.slug}/sandboxes/${id}`,
        mcpEndpoint: `/api/v1/sandboxes/${id}/mcp` }, 201);
    } catch (error) {
      return privateJson({ error: 'SSH sandbox operation failed. Verify the workspace target configuration and runtime ownership.' }, error instanceof RequestBodyError ? error.status : 409);
    } finally { release(); }
  });
}
