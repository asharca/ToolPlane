'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { deleteChatAssistant } from '@/lib/chat/service';
import {
  ignoreMarketUpdate,
  MarketError,
  publishAssistantRelease,
  publishSkillRelease,
  removeMarketInstall,
} from '@/lib/market/skills';
import {
  installMarketRelease,
  publishMcpRelease,
  publishToolkitRelease,
  updateMarketInstall,
} from '@/lib/market/resources';
import {
  unpublishMarketListing,
  withdrawMarketRelease,
} from '@/lib/market/publisher-management';
import { getWorkspaceForUser } from '@/lib/workspace/queries';

export type MarketActionState = {
  ok?: boolean;
  error?: string;
  listingId?: string;
};

async function actionContext(workspaceSlug: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const workspace = await getWorkspaceForUser(workspaceSlug, user.id);
  return workspace ? { user, workspace } : null;
}

function actionError(error: unknown): string {
  if (error instanceof MarketError) return error.code;
  return 'action_failed';
}

function tags(raw: FormDataEntryValue | null): string[] {
  return String(raw ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function categoryIds(formData: FormData): string[] {
  return formData.getAll('categoryIds').map(String).map((value) => value.trim()).filter(Boolean);
}

export async function publishSkillReleaseAction(
  _previous: MarketActionState,
  formData: FormData,
): Promise<MarketActionState> {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const installedSkillId = String(formData.get('installedSkillId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !installedSkillId) return { error: 'not_authorized' };
  try {
    const result = await publishSkillRelease({
      workspaceId: ctx.workspace.id,
      installedSkillId,
      publishedById: ctx.user.id,
      categoryIds: categoryIds(formData),
      listing: {
        slug: String(formData.get('slug') ?? ''),
        name: String(formData.get('name') ?? ''),
        summary: String(formData.get('summary') ?? ''),
        tags: tags(formData.get('tags')),
      },
      releaseNotes: String(formData.get('releaseNotes') ?? ''),
    });
    revalidatePath(`/app/${workspaceSlug}/market/publish`);
    revalidatePath(`/app/${workspaceSlug}/skills/${installedSkillId}`);
    return { ok: true, listingId: result.listing.id };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function publishAssistantReleaseAction(
  _previous: MarketActionState,
  formData: FormData,
): Promise<MarketActionState> {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const assistantId = String(formData.get('assistantId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !assistantId) return { error: 'not_authorized' };
  try {
    const result = await publishAssistantRelease({
      workspaceId: ctx.workspace.id,
      assistantId,
      publishedById: ctx.user.id,
      categoryIds: categoryIds(formData),
      listing: {
        slug: String(formData.get('slug') ?? ''),
        name: String(formData.get('name') ?? ''),
        summary: String(formData.get('summary') ?? ''),
        tags: tags(formData.get('tags')),
      },
      releaseNotes: String(formData.get('releaseNotes') ?? ''),
    });
    revalidatePath(`/app/${workspaceSlug}/market/publish`);
    revalidatePath(`/app/${workspaceSlug}/chat`);
    return { ok: true, listingId: result.listing.id };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function publishMcpReleaseAction(
  _previous: MarketActionState,
  formData: FormData,
): Promise<MarketActionState> {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const deploymentId = String(formData.get('deploymentId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !deploymentId) return { error: 'not_authorized' };
  try {
    const result = await publishMcpRelease({
      workspaceId: ctx.workspace.id,
      deploymentId,
      publishedById: ctx.user.id,
      categoryIds: categoryIds(formData),
      listing: {
        slug: String(formData.get('slug') ?? ''),
        name: String(formData.get('name') ?? ''),
        summary: String(formData.get('summary') ?? ''),
        tags: tags(formData.get('tags')),
      },
      releaseNotes: String(formData.get('releaseNotes') ?? ''),
    });
    revalidatePath(`/app/${workspaceSlug}/market/publish`);
    revalidatePath(`/app/${workspaceSlug}/mcp/${deploymentId}`);
    return { ok: true, listingId: result.listing.id };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function publishToolkitReleaseAction(
  _previous: MarketActionState,
  formData: FormData,
): Promise<MarketActionState> {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const toolkitId = String(formData.get('toolkitId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !toolkitId) return { error: 'not_authorized' };
  try {
    const result = await publishToolkitRelease({
      workspaceId: ctx.workspace.id,
      toolkitId,
      publishedById: ctx.user.id,
      categoryIds: categoryIds(formData),
      listing: {
        slug: String(formData.get('slug') ?? ''),
        name: String(formData.get('name') ?? ''),
        summary: String(formData.get('summary') ?? ''),
        tags: tags(formData.get('tags')),
      },
      releaseNotes: String(formData.get('releaseNotes') ?? ''),
    });
    revalidatePath(`/app/${workspaceSlug}/market/publish`);
    revalidatePath(`/app/${workspaceSlug}/toolkits`);
    return { ok: true, listingId: result.listing.id };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function installMarketResourceAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const releaseId = String(formData.get('releaseId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !releaseId) return;
  const result = await installMarketRelease({
    releaseId,
    targetWorkspaceId: ctx.workspace.id,
    installedById: ctx.user.id,
    idempotencyKey: String(formData.get('idempotencyKey') ?? '') || randomUUID(),
  });
  revalidatePath(`/app/${workspaceSlug}/market`);
  revalidatePath(`/app/${workspaceSlug}/market/installed`);
  if (result.kind === 'skill') {
    revalidatePath(`/app/${workspaceSlug}/skills`);
    redirect(`/app/${workspaceSlug}/skills/${result.resource.id}`);
  }
  if (result.kind === 'mcp') {
    revalidatePath(`/app/${workspaceSlug}/mcp`);
    redirect(`/app/${workspaceSlug}/mcp/${result.resource.id}${
      result.resource.status === 'setup_required' ? '?tab=variables' : ''
    }`);
  }
  if (result.kind === 'toolkit') {
    if (!('slug' in result.resource)) {
      throw new MarketError('listing_conflict', 'The toolkit installation is inconsistent.');
    }
    revalidatePath(`/app/${workspaceSlug}/toolkits`);
    redirect(`/app/${workspaceSlug}/toolkits/${result.resource.slug}`);
  }
}

export const installMarketSkillAction = installMarketResourceAction;

export async function updateMarketInstallAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !installId) return;
  const result = await updateMarketInstall({
    installId,
    targetWorkspaceId: ctx.workspace.id,
    actorId: ctx.user.id,
    targetReleaseId: String(formData.get('targetReleaseId') ?? '') || undefined,
    currentReleaseId: String(formData.get('currentReleaseId') ?? '') || undefined,
    force: formData.get('force') === 'yes',
  });
  revalidatePath(`/app/${workspaceSlug}/market`, 'layout');
  revalidatePath(`/app/${workspaceSlug}/market/installed`);
  if (result.installedSkillId) revalidatePath(`/app/${workspaceSlug}/skills/${result.installedSkillId}`);
}

export async function ignoreMarketUpdateAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !installId) return;
  await ignoreMarketUpdate({
    installId,
    targetWorkspaceId: ctx.workspace.id,
    actorId: ctx.user.id,
    targetReleaseId: String(formData.get('targetReleaseId') ?? '') || undefined,
    currentReleaseId: String(formData.get('currentReleaseId') ?? '') || undefined,
  });
  revalidatePath(`/app/${workspaceSlug}/market`, 'layout');
  revalidatePath(`/app/${workspaceSlug}/market/installed`);
}

export async function removeMarketInstallAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const installId = String(formData.get('installId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !installId) return;
  try {
    await removeMarketInstall({
      installId,
      targetWorkspaceId: ctx.workspace.id,
      actorId: ctx.user.id,
    });
  } catch (error) {
    const code = error instanceof MarketError ? error.code : 'action_failed';
    redirect(`/app/${encodeURIComponent(workspaceSlug)}/market/installed?error=${encodeURIComponent(code)}`);
  }
  revalidatePath(`/app/${workspaceSlug}/market`, 'layout');
  revalidatePath(`/app/${workspaceSlug}/market/installed`);
  redirect(`/app/${encodeURIComponent(workspaceSlug)}/market/installed`);
}

export async function withdrawMarketReleaseAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const listingId = String(formData.get('listingId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !listingId) return;
  await withdrawMarketRelease({
    workspaceId: ctx.workspace.id,
    listingId,
    actorId: ctx.user.id,
  });
  revalidatePath(`/app/${workspaceSlug}/market`, 'layout');
  revalidatePath(`/app/${workspaceSlug}/market/publish`);
}

export async function unpublishMarketListingAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const listingId = String(formData.get('listingId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !listingId) return;
  await unpublishMarketListing({
    workspaceId: ctx.workspace.id,
    listingId,
    actorId: ctx.user.id,
  });
  revalidatePath(`/app/${workspaceSlug}/market`, 'layout');
  revalidatePath(`/app/${workspaceSlug}/market/publish`);
}

export async function removeAssistantMarketCopyAction(formData: FormData) {
  const workspaceSlug = String(formData.get('workspace') ?? '');
  const assistantId = String(formData.get('assistantId') ?? '');
  const ctx = await actionContext(workspaceSlug);
  if (!ctx || !assistantId) return;
  try {
    await deleteChatAssistant(ctx.user.id, assistantId);
  } catch {
    redirect(`/app/${encodeURIComponent(workspaceSlug)}/market/installed?error=action_failed`);
  }
  revalidatePath(`/app/${workspaceSlug}/market`, 'layout');
  revalidatePath(`/app/${workspaceSlug}/market/installed`);
  revalidatePath(`/app/${workspaceSlug}/chat`);
  redirect(`/app/${encodeURIComponent(workspaceSlug)}/market/installed`);
}
