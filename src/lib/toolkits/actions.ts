'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { parseServerRecipe, recipeToDeploymentData } from '@/lib/workspace/server-recipe';
import { MAX_TOOLKIT_BATCH_ITEMS } from '@/lib/toolkits/limits';

async function authorizedWorkspace(slug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) return null;
  return { user, ws };
}

async function toolkitInWorkspace(toolkitSlug: string, workspaceId: string) {
  return db.toolkit.findFirst({ where: { slug: toolkitSlug, workspaceId } });
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'toolkit';
}

export async function createToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const name = String(formData.get('name') ?? '').trim() || 'New toolkit';
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;

  const base = slugify(name);
  let toolkitSlug = base;
  for (
    let i = 1;
    await db.toolkit.findFirst({
      where: { workspaceId: ctx.ws.id, slug: toolkitSlug },
    });
    i += 1
  ) {
    toolkitSlug = `${base}-${i}`;
  }

  await db.toolkit.create({
    data: { workspaceId: ctx.ws.id, name, slug: toolkitSlug },
  });
  revalidatePath(`/app/${slug}/toolkits`);
  redirect(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function clonePublicToolkitAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const sourceToolkitId = String(formData.get('toolkitId') ?? '');
  const ctx = await authorizedWorkspace(workspaceSlug);
  if (!ctx || !sourceToolkitId) return;

  const source = await db.toolkit.findFirst({
    where: { id: sourceToolkitId, visibility: 'public', enabled: true },
    include: {
      servers: {
        include: {
          deployment: {
            include: {
              server: {
                select: { id: true, name: true, installCfg: true, verifiedAt: true },
              },
            },
          },
        },
      },
      skills: {
        include: {
          installedSkill: {
            include: { skill: { select: { id: true } } },
          },
        },
      },
    },
  });
  if (!source) return;
  if (source.workspaceId === ctx.ws.id) {
    return redirect(`/app/${workspaceSlug}/toolkits/${source.slug}`);
  }

  const base = slugify(source.name);
  let nextSlug = base;
  for (
    let i = 1;
    await db.toolkit.findFirst({
      where: { workspaceId: ctx.ws.id, slug: nextSlug },
    });
    i += 1
  ) {
    nextSlug = `${base}-${i}`;
  }

  const cloned = await db.$transaction(async (tx) => {
    const target = await tx.toolkit.create({
      data: {
        workspaceId: ctx.ws.id,
        name: source.name,
        slug: nextSlug,
        visibility: 'private',
        enabled: true,
      },
    });

    for (const link of source.servers) {
      const deployment = link.deployment;
      if (!deployment.serverId || !deployment.server?.verifiedAt) continue;

      const recipe = parseServerRecipe(deployment.server.installCfg);
      if (!recipe) continue;
      const data = recipeToDeploymentData(recipe);
      const targetDeployment = await tx.deployment.upsert({
        where: {
          workspaceId_serverId: {
            workspaceId: ctx.ws.id,
            serverId: deployment.serverId,
          },
        },
        update: {},
        create: {
          workspaceId: ctx.ws.id,
          serverId: deployment.serverId,
          status: 'stopped',
          source: data.source,
          sourceRef: data.sourceRef,
          installCfg: data.installCfg as Prisma.InputJsonValue,
        },
      });

      await tx.toolkitServer.upsert({
        where: {
          toolkitId_deploymentId: {
            toolkitId: target.id,
            deploymentId: targetDeployment.id,
          },
        },
        update: {},
        create: {
          toolkitId: target.id,
          deploymentId: targetDeployment.id,
        },
      });
    }

    for (const link of source.skills) {
      const installed = link.installedSkill;
      const targetSkill = installed.skillId
        ? await tx.installedSkill.upsert({
            where: {
              workspaceId_skillId: {
                workspaceId: ctx.ws.id,
                skillId: installed.skillId,
              },
            },
            update: {},
            create: {
              workspaceId: ctx.ws.id,
              skillId: installed.skillId,
            },
          })
        : await tx.installedSkill.create({
            data: {
              workspaceId: ctx.ws.id,
              name: installed.name,
              slug: installed.slug,
              description: installed.description,
              content: installed.content,
              source: installed.source,
              sourceRef: installed.sourceRef,
              status: installed.status,
              userInvocable: installed.userInvocable,
              agentInvocable: installed.agentInvocable,
              effort: installed.effort,
              ...(installed.files === null
                ? {}
                : { files: installed.files as Prisma.InputJsonValue }),
            },
          });

      await tx.toolkitSkill.upsert({
        where: {
          toolkitId_installedSkillId: {
            toolkitId: target.id,
            installedSkillId: targetSkill.id,
          },
        },
        update: {},
        create: {
          toolkitId: target.id,
          installedSkillId: targetSkill.id,
        },
      });
    }

    return target;
  });

  revalidatePath(`/app/${workspaceSlug}/toolkits`);
  revalidatePath(`/app/${workspaceSlug}/toolkits/new`);
  redirect(`/app/${workspaceSlug}/toolkits/${cloned.slug}`);
}

export async function deleteToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  if (toolkitSlug === 'me') return; // default toolkit is not deletable
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkit.delete({ where: { id: tk.id } });
  revalidatePath(`/app/${slug}/toolkits`);
  redirect(`/app/${slug}/toolkits`);
}

export async function setToolkitVisibilityAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const visibility =
    String(formData.get('visibility') ?? '') === 'public' ? 'public' : 'private';
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkit.update({ where: { id: tk.id }, data: { visibility } });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export type ToolkitBatchActionState = { error?: string; added?: number };

const MAX_RESOURCE_ID_LENGTH = 128;

function parseBatchResourceIds(formData: FormData): { ids: string[] } | { error: string } {
  const raw = formData.getAll('resourceId');
  if (raw.length === 0) return { error: 'Select at least one item.' };
  if (raw.length > MAX_TOOLKIT_BATCH_ITEMS) {
    return { error: `Select no more than ${MAX_TOOLKIT_BATCH_ITEMS} items at once.` };
  }

  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') return { error: 'Invalid resource selection.' };
    const id = value.trim();
    if (!id || id.length > MAX_RESOURCE_ID_LENGTH) return { error: 'Invalid resource selection.' };
    ids.push(id);
  }
  return { ids: [...new Set(ids)] };
}

async function addToolkitResources(
  kind: 'mcp' | 'skill',
  workspaceSlug: string,
  toolkitSlug: string,
  ids: string[],
): Promise<ToolkitBatchActionState> {
  const ctx = await authorizedWorkspace(workspaceSlug);
  if (!ctx) return { error: 'Workspace not found or access denied.' };

  try {
    const result = await db.$transaction(async (tx) => {
      const toolkit = await tx.toolkit.findFirst({
        where: { slug: toolkitSlug, workspaceId: ctx.ws.id },
        select: { id: true },
      });
      if (!toolkit) return { error: 'Toolkit not found.' };

      if (kind === 'mcp') {
        const owned = await tx.deployment.findMany({
          where: {
            workspaceId: ctx.ws.id,
            id: { in: ids },
            OR: [{ source: null }, { source: { notIn: ['sandbox'] } }],
          },
          select: { id: true },
        });
        if (owned.length !== ids.length) return { error: 'One or more selected MCPs are unavailable.' };
        const created = await tx.toolkitServer.createMany({
          data: owned.map(({ id }) => ({ toolkitId: toolkit.id, deploymentId: id })),
          skipDuplicates: true,
        });
        return { added: created.count };
      }

      const owned = await tx.installedSkill.findMany({
        where: { workspaceId: ctx.ws.id, id: { in: ids } },
        select: { id: true },
      });
      if (owned.length !== ids.length) return { error: 'One or more selected skills are unavailable.' };
      const created = await tx.toolkitSkill.createMany({
        data: owned.map(({ id }) => ({ toolkitId: toolkit.id, installedSkillId: id })),
        skipDuplicates: true,
      });
      return { added: created.count };
    });

    if (!('error' in result)) {
      revalidatePath(`/app/${workspaceSlug}/toolkits/${toolkitSlug}`);
    }
    return result;
  } catch {
    return { error: 'Failed to add selected items.' };
  }
}

export async function addServersToToolkitAction(
  _previous: ToolkitBatchActionState,
  formData: FormData,
): Promise<ToolkitBatchActionState> {
  const parsed = parseBatchResourceIds(formData);
  if ('error' in parsed) return parsed;
  return addToolkitResources(
    'mcp',
    String(formData.get('workspace') ?? ''),
    String(formData.get('toolkitSlug') ?? ''),
    parsed.ids,
  );
}

export async function addSkillsToToolkitAction(
  _previous: ToolkitBatchActionState,
  formData: FormData,
): Promise<ToolkitBatchActionState> {
  const parsed = parseBatchResourceIds(formData);
  if ('error' in parsed) return parsed;
  return addToolkitResources(
    'skill',
    String(formData.get('workspace') ?? ''),
    String(formData.get('toolkitSlug') ?? ''),
    parsed.ids,
  );
}

export async function addServerToToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;
  const dep = await db.deployment.findFirst({
    where: {
      id: deploymentId,
      workspaceId: ctx.ws.id,
      OR: [{ source: null }, { source: { notIn: ['sandbox'] } }],
    },
    select: { id: true },
  });
  if (!dep) return;

  await db.toolkitServer.upsert({
    where: { toolkitId_deploymentId: { toolkitId: tk.id, deploymentId } },
    update: {},
    create: { toolkitId: tk.id, deploymentId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function removeServerFromToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkitServer.deleteMany({
    where: { toolkitId: tk.id, deploymentId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function addSkillToToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const installedSkillId = String(formData.get('installedSkillId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;
  const inst = await db.installedSkill.findFirst({
    where: { id: installedSkillId, workspaceId: ctx.ws.id },
    select: { id: true },
  });
  if (!inst) return;

  await db.toolkitSkill.upsert({
    where: {
      toolkitId_installedSkillId: { toolkitId: tk.id, installedSkillId },
    },
    update: {},
    create: { toolkitId: tk.id, installedSkillId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}

export async function removeSkillFromToolkitAction(formData: FormData) {
  const slug = String(formData.get('workspace') ?? '');
  const toolkitSlug = String(formData.get('toolkitSlug') ?? '');
  const installedSkillId = String(formData.get('installedSkillId') ?? '');
  const ctx = await authorizedWorkspace(slug);
  if (!ctx) return;
  const tk = await toolkitInWorkspace(toolkitSlug, ctx.ws.id);
  if (!tk) return;

  await db.toolkitSkill.deleteMany({
    where: { toolkitId: tk.id, installedSkillId },
  });
  revalidatePath(`/app/${slug}/toolkits/${toolkitSlug}`);
}
