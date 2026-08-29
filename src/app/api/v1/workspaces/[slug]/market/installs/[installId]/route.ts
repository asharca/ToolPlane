import { z } from 'zod';
import { deleteManagedAgent } from '@/lib/agents/deletion';
import { resolveAccountRequestUser } from '@/lib/auth/request-user';
import { ChatServiceError, deleteChatAssistant } from '@/lib/chat/service';
import { db } from '@/lib/db';
import { marketErrorResponse } from '@/lib/market/http';
import {
  ignoreMarketUpdate,
  removeMarketInstall,
} from '@/lib/market/skills';
import { updateMarketInstall } from '@/lib/market/resources';
import { getWorkspaceForUser } from '@/lib/workspace/queries';

export const runtime = 'nodejs';

const updateBody = z.object({
  action: z.enum(['update', 'ignore']),
  targetReleaseId: z.string().min(1).max(240),
  currentReleaseId: z.string().min(1).max(240),
  force: z.boolean().optional(),
}).strict();

async function context(req: Request, slug: string) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return null;
  const workspace = await getWorkspaceForUser(slug, user.id);
  return workspace ? { user, workspace } : null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; installId: string }> },
) {
  const { slug, installId } = await params;
  const ctx = await context(req, slug);
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = updateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid update request.' }, { status: 400 });
  try {
    const result = parsed.data.action === 'ignore'
      ? await ignoreMarketUpdate({
          installId,
          targetWorkspaceId: ctx.workspace.id,
          actorId: ctx.user.id,
          targetReleaseId: parsed.data.targetReleaseId,
          currentReleaseId: parsed.data.currentReleaseId,
        })
      : await updateMarketInstall({
          installId,
          targetWorkspaceId: ctx.workspace.id,
          actorId: ctx.user.id,
          targetReleaseId: parsed.data.targetReleaseId,
          currentReleaseId: parsed.data.currentReleaseId,
          force: parsed.data.force,
        });
    return Response.json({ id: result.id, status: result.status });
  } catch (error) {
    return marketErrorResponse(error);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string; installId: string }> },
) {
  const { slug, installId } = await params;
  const ctx = await context(req, slug);
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    if (installId.startsWith('agent:')) {
      const id = installId.slice('agent:'.length);
      const install = await db.agentInstall.findFirst({
        where: { id, targetWorkspaceId: ctx.workspace.id },
        select: { agentId: true },
      });
      if (!install?.agentId) {
        return Response.json({ error: 'Market install not found.', code: 'install_not_found' }, { status: 404 });
      }
      if (!await deleteManagedAgent({
        workspaceId: ctx.workspace.id,
        agentId: install.agentId,
        actorId: ctx.user.id,
      })) {
        return Response.json({ error: 'Agent could not be removed.', code: 'install_conflict' }, { status: 409 });
      }
      return new Response(null, { status: 204 });
    }
    if (installId.startsWith('assistant:')) {
      const assistantId = installId.slice('assistant:'.length);
      const assistant = await db.chatAssistant.findFirst({
        where: {
          id: assistantId,
          workspaceId: ctx.workspace.id,
          marketTemplateReleaseId: { not: null },
        },
        select: { id: true },
      });
      if (!assistant) {
        return Response.json({ error: 'Market install not found.', code: 'install_not_found' }, { status: 404 });
      }
      await deleteChatAssistant(ctx.user.id, assistant.id);
      return new Response(null, { status: 204 });
    }
    await removeMarketInstall({ installId, targetWorkspaceId: ctx.workspace.id, actorId: ctx.user.id });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ChatServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return marketErrorResponse(error);
  }
}
