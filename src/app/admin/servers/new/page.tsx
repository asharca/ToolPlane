import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { createServerAction } from '@/lib/admin/market-actions';
import { ServerForm } from '@/components/admin/ServerForm';
import { AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';

export const dynamic = 'force-dynamic';

export default async function NewServerPage() {
  const t = await getTranslations('admin');
  await requireAdmin();
  const categories = await listCategories();
  return (
    <AdminPage className="max-w-4xl">
      <AdminPageHeader
        title={t('addServer')}
        backHref="/admin/servers"
        backLabel={t('toolplane')}
      />
      <section className="border-t border-border pt-6" aria-label={t('addServer')}>
        <ServerForm
          action={createServerAction}
          initial={{}}
          categories={categories}
          submitLabel={t('create')}
        />
      </section>
    </AdminPage>
  );
}
