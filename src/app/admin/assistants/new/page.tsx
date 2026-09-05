import { getTranslations } from 'next-intl/server';
import { AgentListingForm } from '@/components/admin/AgentListingForm';
import { AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';
import { listCatalogAgentResources } from '@/lib/admin/agent-market';
import { listCategories } from '@/lib/admin/categories';
import { createAssistantTemplateAdminAction } from '@/lib/admin/market-catalog-actions';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export default async function NewAssistantTemplatePage() {
  await requireAdmin();
  const [t, categories, resources] = await Promise.all([
    getTranslations('admin'),
    listCategories(),
    listCatalogAgentResources(),
  ]);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={t('addAssistantTemplate')}
        description={t('addAssistantTemplateDescription')}
        backHref="/admin/assistants"
        backLabel={t('directoryAssistants')}
      />
      <AgentListingForm
        action={createAssistantTemplateAdminAction}
        initial={{
          author: 'ToolPlane',
          curated: true,
          status: 'published',
          maxSteps: AGENT_STEP_BOUNDS.default,
        }}
        categories={categories}
        servers={resources.servers}
        skills={[]}
        submitLabel={t('createAssistantTemplate')}
        mode="assistant"
      />
    </AdminPage>
  );
}
