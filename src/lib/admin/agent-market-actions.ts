'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import {
  ADMIN_AGENT_LISTING_STATUSES,
  AdminAgentMarketError,
  approvePendingAgentRelease,
  createDirectoryAgentTemplate,
  deleteDirectoryAgentListing,
  normalizeAgentListingTags,
  rejectPendingAgentRelease,
  setDirectoryAgentListingStatus,
  updateDirectoryAgentListing,
  type AdminAgentListingStatus,
  type CatalogAgentConfigInput,
} from '@/lib/admin/agent-market';
import { requireAdmin } from '@/lib/auth/admin';
import type { AdminActionState } from '@/lib/admin/user-actions';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
const MODEL_FORMATS = new Set(['openai', 'openai-responses', 'anthropic']);

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

function nullable(value: string): string | null {
  return value === '' ? null : value;
}

function ids(formData: FormData, key: string): string[] {
  return [...new Set(formData.getAll(key).map(String).filter(Boolean))];
}

function listingStatus(formData: FormData): AdminAgentListingStatus {
  const requested = str(formData, 'status');
  return ADMIN_AGENT_LISTING_STATUSES.includes(requested as AdminAgentListingStatus)
    ? requested as AdminAgentListingStatus
    : 'draft';
}

function parseTags(formData: FormData): string[] {
  return normalizeAgentListingTags(str(formData, 'tags').split(','));
}

function parseConfig(formData: FormData): CatalogAgentConfigInput | null {
  const modelFormat = nullable(str(formData, 'modelFormat'));
  const model = nullable(str(formData, 'model'));
  if (Boolean(modelFormat) !== Boolean(model)) return null;
  if (modelFormat && !MODEL_FORMATS.has(modelFormat)) return null;

  const rawMaxSteps = Number(str(formData, 'maxSteps'));
  if (!Number.isInteger(rawMaxSteps)
    || rawMaxSteps < AGENT_STEP_BOUNDS.min
    || rawMaxSteps > AGENT_STEP_BOUNDS.max) {
    return null;
  }
  return {
    systemPrompt: nullable(str(formData, 'systemPrompt')),
    maxSteps: rawMaxSteps,
    modelFormat,
    model,
    serverIds: ids(formData, 'serverIds'),
    skillIds: ids(formData, 'skillIds'),
  };
}

function actionErrorKey(error: unknown):
  | 'errorAgentDirectorySlugExists'
  | 'errorAgentListingInstalled'
  | 'errorAgentReleaseNotPending'
  | 'errorAgentReleasePendingBeforeConfig'
  | 'errorAgentApprovedReleaseRequired'
  | 'errorAgentPublisherWorkspaceMissing'
  | 'errorInvalidAgentTemplateConfig'
  | 'errorInvalidAgentRelease'
  | 'errorMarketCategoryRequired'
  | 'errorInvalidMarketCategories'
  | 'errorActionFailed' {
  if (!(error instanceof AdminAgentMarketError)) return 'errorActionFailed';
  if (error.code === 'slug_conflict') return 'errorAgentDirectorySlugExists';
  if (error.code === 'installed') return 'errorAgentListingInstalled';
  if (error.code === 'release_not_found' || error.code === 'release_not_pending') {
    return 'errorAgentReleaseNotPending';
  }
  if (error.code === 'pending_release_exists') return 'errorAgentReleasePendingBeforeConfig';
  if (error.code === 'invalid_config') return 'errorInvalidAgentTemplateConfig';
  if (error.code === 'invalid_release') return 'errorInvalidAgentRelease';
  if (error.code === 'invalid_categories') return 'errorInvalidMarketCategories';
  if (error.code === 'publish_without_release') return 'errorAgentApprovedReleaseRequired';
  if (error.code === 'orphaned_publisher') return 'errorAgentPublisherWorkspaceMissing';
  return 'errorActionFailed';
}

function revalidateAgentDirectory(id?: string) {
  revalidatePath('/admin/agents');
  if (id) revalidatePath(`/admin/agents/${id}/edit`);
  revalidatePath('/app/[workspace]/market/agents', 'page');
}

export async function createAgentListingAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const directorySlug = str(formData, 'directorySlug').toLowerCase();
  const name = str(formData, 'name').slice(0, 240);
  const summary = nullable(str(formData, 'summary').slice(0, 4000));
  const config = parseConfig(formData);
  if (!name || !SLUG_RE.test(directorySlug)) return { error: t('errorAgentNameSlugRequired') };
  if (!config) return { error: t('errorInvalidAgentTemplateConfig') };

  let listingId: string;
  try {
    const created = await createDirectoryAgentTemplate({
      directorySlug,
      name,
      author: nullable(str(formData, 'author').slice(0, 240)),
      summary,
      iconUrl: nullable(str(formData, 'iconUrl').slice(0, 2000)),
      tags: parseTags(formData),
      curated: true,
      isFeatured: formData.get('isFeatured') === 'on',
      categoryIds: ids(formData, 'categoryIds'),
      status: listingStatus(formData),
      ...config,
    }, admin.id);
    listingId = created.id;
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }

  revalidateAgentDirectory(listingId);
  redirect(`/admin/agents/${listingId}/edit`);
}

export async function updateAgentListingAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(formData, 'id');
  const directorySlug = str(formData, 'directorySlug').toLowerCase();
  const name = str(formData, 'name').slice(0, 240);
  if (!id || !name || !SLUG_RE.test(directorySlug)) {
    return { error: t('errorAgentNameSlugRequired') };
  }
  const shouldUpdateConfig = formData.get('updateConfig') === 'yes';
  const config = shouldUpdateConfig ? parseConfig(formData) : undefined;
  if (shouldUpdateConfig && !config) return { error: t('errorInvalidAgentTemplateConfig') };

  try {
    await updateDirectoryAgentListing(id, {
      directorySlug,
      name,
      author: nullable(str(formData, 'author').slice(0, 240)),
      summary: nullable(str(formData, 'summary').slice(0, 4000)),
      iconUrl: nullable(str(formData, 'iconUrl').slice(0, 2000)),
      tags: parseTags(formData),
      curated: formData.get('curated') === 'on',
      isFeatured: formData.get('isFeatured') === 'on',
      categoryIds: ids(formData, 'categoryIds'),
      status: listingStatus(formData),
      ...(config ? { config } : {}),
    }, admin.id);
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }

  revalidateAgentDirectory(id);
  return { ok: true };
}

export async function approveAgentReleaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const listingId = str(formData, 'listingId');
  const releaseId = str(formData, 'releaseId');
  const categoryIds = ids(formData, 'categoryIds');
  if (formData.get('reviewConfirmed') !== 'yes') {
    return { error: t('errorAgentReviewConfirmationRequired') };
  }
  if (categoryIds.length === 0) return { error: t('errorMarketCategoryRequired') };
  try {
    await approvePendingAgentRelease({
      listingId,
      releaseId,
      reviewedById: admin.id,
      reviewNote: nullable(str(formData, 'reviewNote').slice(0, 4000)),
      categoryIds,
    });
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }
  revalidateAgentDirectory(listingId);
  return { ok: true };
}

export async function rejectAgentReleaseAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const listingId = str(formData, 'listingId');
  const releaseId = str(formData, 'releaseId');
  try {
    await rejectPendingAgentRelease({
      listingId,
      releaseId,
      reviewedById: admin.id,
      reviewNote: nullable(str(formData, 'reviewNote').slice(0, 4000)),
    });
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }
  revalidateAgentDirectory(listingId);
  return { ok: true };
}

export async function setAgentListingStatusAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(formData, 'id');
  const status = str(formData, 'status') === 'published' ? 'published' : 'disabled';
  try {
    await setDirectoryAgentListingStatus(id, status);
  } catch (error) {
    return { error: t(actionErrorKey(error)) };
  }
  revalidateAgentDirectory(id);
  return { ok: true };
}

export async function deleteAgentListingAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = str(formData, 'id');
  try {
    await deleteDirectoryAgentListing(id);
  } catch (error) {
    const key = actionErrorKey(error);
    if (key === 'errorAgentListingInstalled' && error instanceof AdminAgentMarketError) {
      return { error: t(key, { count: error.count ?? 0 }) };
    }
    return { error: t(key) };
  }
  revalidateAgentDirectory();
  redirect('/admin/agents');
}
