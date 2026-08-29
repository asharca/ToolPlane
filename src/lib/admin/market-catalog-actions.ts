'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  ADMIN_MARKET_LISTING_STATUSES,
  AdminMarketCatalogError,
  createAdminAssistantTemplate,
  deleteAdminAssistantTemplate,
  updateAdminMarketListing,
  updateAdminAssistantTemplate,
  updateAdminPublicToolkit,
  type AdminMarketListingStatus,
} from '@/lib/admin/market-catalog';
import { requireAdmin } from '@/lib/auth/admin';
import type { AdminActionState } from '@/lib/admin/user-actions';

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim();
}

function categoryIds(formData: FormData) {
  return formData.getAll('categoryIds').map(String).filter(Boolean);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const ASSISTANT_MODEL_FORMATS = new Set(['openai', 'openai-responses', 'openai-compatible', 'anthropic']);

function nullable(input: string) {
  return input || null;
}

function tags(formData: FormData) {
  return value(formData, 'tags').split(',').map((tag) => tag.trim()).filter(Boolean);
}

function assistantTemplateInput(formData: FormData) {
  const slug = value(formData, 'directorySlug').toLowerCase();
  const name = value(formData, 'name').slice(0, 120);
  const author = value(formData, 'author').slice(0, 240);
  const requestedStatus = value(formData, 'status');
  const status = ADMIN_MARKET_LISTING_STATUSES.includes(requestedStatus as AdminMarketListingStatus)
    ? requestedStatus as AdminMarketListingStatus
    : 'draft';
  const modelFormat = nullable(value(formData, 'modelFormat'));
  const model = nullable(value(formData, 'model'));
  const maxSteps = Number(value(formData, 'maxSteps'));
  if (!name || !author || !SLUG_RE.test(slug)) return { error: 'identity' as const };
  if (
    !Number.isInteger(maxSteps)
    || maxSteps < 1
    || maxSteps > 20
    || Boolean(modelFormat) !== Boolean(model)
    || (modelFormat && !ASSISTANT_MODEL_FORMATS.has(modelFormat))
  ) return { error: 'config' as const };
  return {
    input: {
      slug,
      name,
      author,
      summary: nullable(value(formData, 'summary').slice(0, 4_000)),
      iconUrl: nullable(value(formData, 'iconUrl').slice(0, 2_000)),
      tags: tags(formData),
      categoryIds: categoryIds(formData),
      status,
      isFeatured: formData.get('isFeatured') === 'on',
      systemPrompt: nullable(value(formData, 'systemPrompt').slice(0, 50_000)),
      maxSteps,
      modelFormat,
      model,
      serverIds: [...new Set(formData.getAll('serverIds').map(String).filter(Boolean))],
    },
  };
}

function errorKey(error: unknown) {
  if (!(error instanceof AdminMarketCatalogError)) return 'errorActionFailed' as const;
  if (error.code === 'invalid_categories') return 'errorInvalidMarketCategories' as const;
  if (error.code === 'release_required') return 'errorMarketApprovedReleaseRequired' as const;
  if (error.code === 'invalid_config') return 'errorInvalidAssistantTemplateConfig' as const;
  if (error.code === 'invalid_manifest') return 'errorInvalidMarketRelease' as const;
  if (error.code === 'slug_conflict') return 'errorAssistantTemplateSlugExists' as const;
  return 'errorMarketResourceNotFound' as const;
}

function revalidateMarket() {
  revalidatePath('/admin/market');
  revalidatePath('/app/[workspace]/market', 'layout');
  revalidatePath('/categories');
  revalidatePath('/categories/[slug]', 'page');
}

export async function updateMarketListingAdminAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = value(formData, 'listingId');
  const requestedStatus = value(formData, 'status');
  if (!id || !ADMIN_MARKET_LISTING_STATUSES.includes(requestedStatus as AdminMarketListingStatus)) {
    return { error: t('errorMarketResourceNotFound') };
  }
  try {
    await updateAdminMarketListing({
      id,
      status: requestedStatus as AdminMarketListingStatus,
      curated: formData.get('curated') === 'on',
      isFeatured: formData.get('isFeatured') === 'on',
      categoryIds: categoryIds(formData),
    });
  } catch (error) {
    return { error: t(errorKey(error)) };
  }
  revalidateMarket();
  return { ok: true };
}

export async function updatePublicToolkitAdminAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = value(formData, 'toolkitId');
  if (!id) return { error: t('errorMarketResourceNotFound') };
  try {
    await updateAdminPublicToolkit({
      id,
      enabled: formData.get('enabled') === 'on',
      categoryIds: categoryIds(formData),
    });
  } catch (error) {
    return { error: t(errorKey(error)) };
  }
  revalidateMarket();
  return { ok: true };
}

export async function createAssistantTemplateAdminAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const parsed = assistantTemplateInput(formData);
  if ('error' in parsed) {
    return { error: t(parsed.error === 'identity'
      ? 'errorAssistantTemplateNameSlugRequired'
      : 'errorInvalidAssistantTemplateConfig') };
  }

  try {
    await createAdminAssistantTemplate(parsed.input, admin.id);
  } catch (error) {
    return { error: t(errorKey(error)) };
  }
  revalidateMarket();
  revalidatePath('/admin/assistants');
  redirect('/admin/assistants');
}

export async function updateAssistantTemplateAdminAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const id = value(formData, 'id');
  const parsed = assistantTemplateInput(formData);
  if (!id || ('error' in parsed && parsed.error === 'identity')) {
    return { error: t('errorAssistantTemplateNameSlugRequired') };
  }
  if ('error' in parsed) return { error: t('errorInvalidAssistantTemplateConfig') };
  try {
    await updateAdminAssistantTemplate(id, parsed.input, admin.id);
  } catch (error) {
    return { error: t(errorKey(error)) };
  }
  revalidateMarket();
  revalidatePath('/admin/assistants');
  redirect('/admin/assistants');
}

export async function deleteAssistantTemplateAdminAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireAdmin();
  const t = await getTranslations('admin');
  const id = value(formData, 'id');
  if (!id) return { error: t('errorMarketResourceNotFound') };
  try {
    await deleteAdminAssistantTemplate(id);
  } catch (error) {
    return { error: t(errorKey(error)) };
  }
  revalidateMarket();
  revalidatePath('/admin/assistants');
  redirect('/admin/assistants');
}
