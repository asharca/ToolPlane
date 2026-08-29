import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AgentListingForm } from '@/components/admin/AgentListingForm';
import { AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { listCatalogAgentResources } from '@/lib/admin/agent-market';
import { listCategories } from '@/lib/admin/categories';
import {
  deleteAssistantTemplateAdminAction,
  updateAssistantTemplateAdminAction,
} from '@/lib/admin/market-catalog-actions';
import { getAdminAssistantTemplate } from '@/lib/admin/market-catalog';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export default async function EditAssistantTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const [t, template, categories, resources] = await Promise.all([
    getTranslations('admin'),
    getAdminAssistantTemplate(id),
    listCategories(),
    listCatalogAgentResources(),
  ]);
  if (!template) notFound();
  const { listing, manifest, serverIds } = template;
  const assistant = manifest.assistant;

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={t('editAssistantTemplate')}
        description={t('editAssistantTemplateDescription')}
        backHref="/admin/assistants"
        backLabel={t('directoryAssistants')}
      />
      <AgentListingForm
        action={updateAssistantTemplateAdminAction}
        initial={{
          id: listing.id,
          directorySlug: listing.slug,
          name: listing.name,
          author: manifest.listing?.author ?? null,
          summary: listing.summary,
          iconUrl: listing.iconUrl,
          tags: listing.tags,
          curated: listing.curated,
          isFeatured: listing.isFeatured,
          categoryIds: listing.categories.map(({ id: categoryId }) => categoryId),
          status: listing.status,
          systemPrompt: assistant.systemPrompt,
          maxSteps: assistant.maxSteps,
          modelFormat: assistant.modelRequirement?.providerFormat ?? null,
          model: assistant.modelRequirement?.model ?? null,
          serverIds,
        }}
        categories={categories}
        servers={resources.servers}
        skills={[]}
        submitLabel={t('publishAssistantTemplateVersion')}
        mode="assistant"
      />
      <div className="border-t border-border pt-6">
        <ConfirmDialog
          label={t('deleteAssistantTemplate')}
          prompt={t('deleteAssistantTemplatePrompt')}
          action={deleteAssistantTemplateAdminAction}
          hidden={{ id: listing.id }}
          pendingLabel={t('deleting')}
          tone="danger"
        />
      </div>
    </AdminPage>
  );
}
