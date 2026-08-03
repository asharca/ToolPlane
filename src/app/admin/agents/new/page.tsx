import { getTranslations } from 'next-intl/server';
import { AgentListingForm } from '@/components/admin/AgentListingForm';
import { AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';
import { listCatalogAgentResources } from '@/lib/admin/agent-market';
import { createAgentListingAction } from '@/lib/admin/agent-market-actions';
import { listCategories } from '@/lib/admin/categories';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export default async function NewAgentListingPage() {
  await requireAdmin();
  const [t, categories, resources] = await Promise.all([
    getTranslations('admin'),
    listCategories(),
    listCatalogAgentResources(),
  ]);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={t('addAgentTemplate')}
        description={t('addAgentTemplateDescription')}
        backHref="/admin/agents"
        backLabel={t('directoryAgents')}
      />
      <AgentListingForm
        action={createAgentListingAction}
        initial={{ curated: true, status: 'published' }}
        categories={categories}
        servers={resources.servers}
        skills={resources.skills}
        submitLabel={t('createAgentTemplate')}
      />
    </AdminPage>
  );
}
