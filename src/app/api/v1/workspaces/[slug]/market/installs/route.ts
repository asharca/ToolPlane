import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentMarketError, materializeAgentRelease } from '@/lib/agents/market';
import { syncHermesRuntime } from '@/lib/agents/hermes/runtime';
import { resolveAccountRequestUser } from '@/lib/auth/request-user';
import {
  ChatServiceError,
  installAssistantMarketRelease,
} from '@/lib/chat/service';
import { marketErrorResponse } from '@/lib/market/http';
import { listWorkspaceMarketInstalls } from '@/lib/market/skills';
import { installMarketRelease } from '@/lib/market/resources';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

const installBody = z.object({
  releaseId: z.string().min(1).max(240),
  idempotencyKey: z.string().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  systemPrompt: z.string().trim().max(50_000).nullable().optional(),
  modelProviderId: z.string().trim().min(1).max(240).optional(),
  model: z.string().trim().max(240).nullable().optional(),
  maxSteps: z.number().int().min(1).max(20).optional(),
  deploymentIds: z.array(z.string().trim().min(1).max(240)).max(50)
    .transform((ids) => [...new Set(ids)]).optional(),
}).strict();

async function context(req: Request, slug: string) {
  const user = await resolveAccountRequestUser(req);
  if (!user) return null;
  const workspace = await getWorkspaceForUser(slug, user.id);
  return workspace ? { user, workspace } : null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const ctx = await context(req, slug);
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const [marketInstalls, agentInstalls, assistants] = await Promise.all([
    listWorkspaceMarketInstalls(ctx.workspace.id),
    db.agentInstall.findMany({
      where: { targetWorkspaceId: ctx.workspace.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        agent: { select: { id: true, name: true, runtimeKind: true } },
        release: {
          select: {
            id: true,
            version: true,
            listing: {
              select: {
                id: true,
                directorySlug: true,
                name: true,
                iconUrl: true,
                status: true,
                latestRelease: { select: { id: true, version: true } },
              },
            },
          },
        },
      },
    }),
    db.chatAssistant.findMany({
      where: { workspaceId: ctx.workspace.id, marketTemplateReleaseId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        marketTemplateRelease: {
          select: {
            id: true,
            version: true,
            listing: {
              select: {
                id: true,
                namespace: true,
                slug: true,
                name: true,
                iconUrl: true,
                status: true,
                latestRelease: { select: { id: true, version: true, releaseNotes: true } },
              },
            },
          },
        },
      },
    }),
  ]);
  return Response.json({
    items: [
      ...marketInstalls.map((install) => ({
        id: install.id,
        kind: install.listing.kind,
        status: install.status,
        listing: install.listing,
        currentRelease: install.currentRelease,
        resourceId: install.deploymentId
          ?? install.installedSkillId
          ?? install.toolkitId
          ?? install.agentId,
        updateAvailable: install.updateAvailable,
        createdAt: install.createdAt,
        updatedAt: install.updatedAt,
      })),
      ...agentInstalls.map((install) => ({
        id: `agent:${install.id}`,
        kind: 'agent',
        status: install.status,
        listing: install.release.listing,
        currentRelease: { id: install.release.id, version: install.release.version },
        resourceId: install.agent?.id ?? null,
        resource: install.agent,
        updateAvailable: Boolean(
          install.release.listing.status === 'published'
          && install.release.listing.latestRelease
          && install.release.listing.latestRelease.id !== install.release.id,
        ),
        createdAt: install.createdAt,
        updatedAt: install.updatedAt,
      })),
      ...assistants.flatMap((assistant) => {
        const release = assistant.marketTemplateRelease;
        if (!release) return [];
        return [{
          id: `assistant:${assistant.id}`,
          kind: 'assistant',
          status: 'ready',
          listing: release.listing,
          currentRelease: { id: release.id, version: release.version },
          resourceId: assistant.id,
          resource: { id: assistant.id, name: assistant.name },
          updateAvailable: Boolean(
            release.listing.status === 'published'
            && release.listing.latestRelease
            && release.listing.latestRelease.id !== release.id,
          ),
          createdAt: assistant.createdAt,
          updatedAt: assistant.updatedAt,
        }];
      }),
    ],
  });
}

function installErrorResponse(error: unknown) {
  if (error instanceof ChatServiceError) {
    return Response.json({ error: error.message, code: 'assistant_install_failed' }, { status: error.status });
  }
  if (error instanceof AgentMarketError) {
    const status = error.code === 'not_authorized'
      ? 403
      : ['release_not_found', 'target_workspace_not_found'].includes(error.code)
        ? 404
        : ['invalid_manifest', 'invalid_categories', 'not_portable'].includes(error.code)
          ? 422
          : 409;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  return marketErrorResponse(error);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const ctx = await context(req, slug);
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = installBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid install request.' }, { status: 400 });
  const release = await db.marketRelease.findUnique({
    where: { id: parsed.data.releaseId },
    select: { listing: { select: { kind: true } } },
  });
  if (!release) {
    const agentRelease = await db.agentRelease.findUnique({
      where: { id: parsed.data.releaseId },
      select: { id: true },
    });
    if (agentRelease) {
      try {
        const result = await materializeAgentRelease({
          releaseId: parsed.data.releaseId,
          idempotencyKey: parsed.data.idempotencyKey ?? randomUUID(),
          targetWorkspaceId: ctx.workspace.id,
          installedById: ctx.user.id,
          name: parsed.data.name,
        });
        await syncHermesRuntime(ctx.workspace.id, result.agent.id);
        return Response.json({
          installId: `agent:${result.install.id}`,
          kind: 'agent',
          resourceId: result.agent.id,
          agentId: result.agent.id,
          status: result.install.status,
          reused: result.reused,
        }, { status: result.reused ? 200 : 201 });
      } catch (error) {
        return installErrorResponse(error);
      }
    }
    return Response.json({ error: 'Market release not found.', code: 'release_not_found' }, { status: 404 });
  }
  if (release.listing.kind === 'assistant') {
    try {
      const assistant = await installAssistantMarketRelease(ctx.user.id, {
        workspaceId: ctx.workspace.id,
        releaseId: parsed.data.releaseId,
        name: parsed.data.name,
        systemPrompt: parsed.data.systemPrompt,
        modelProviderId: parsed.data.modelProviderId,
        model: parsed.data.model,
        maxSteps: parsed.data.maxSteps,
        deploymentIds: parsed.data.deploymentIds,
      });
      return Response.json({
        installId: `assistant:${assistant.id}`,
        kind: 'assistant',
        resourceId: assistant.id,
        assistantId: assistant.id,
        status: 'ready',
        reused: false,
      }, { status: 201 });
    } catch (error) {
      return installErrorResponse(error);
    }
  }
  if (!['mcp', 'skill', 'toolkit'].includes(release.listing.kind)) {
    return Response.json({ error: 'Unsupported market release kind.', code: 'unsupported_kind' }, { status: 422 });
  }
  try {
    const result = await installMarketRelease({
      releaseId: parsed.data.releaseId,
      idempotencyKey: parsed.data.idempotencyKey ?? randomUUID(),
      targetWorkspaceId: ctx.workspace.id,
      installedById: ctx.user.id,
    });
    return Response.json({
      installId: result.install.id,
      kind: result.kind,
      resourceId: result.resource.id,
      ...(result.kind === 'skill' ? { installedSkillId: result.resource.id } : {}),
      ...(result.kind === 'mcp' ? { deploymentId: result.resource.id } : {}),
      ...(result.kind === 'toolkit' ? { toolkitId: result.resource.id } : {}),
      status: result.install.status,
      reused: result.reused,
    }, { status: result.reused ? 200 : 201 });
  } catch (error) {
    return installErrorResponse(error);
  }
}
