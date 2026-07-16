import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { CategoriesPanel } from '@/components/admin/CategoriesPanel';
import { AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';

export const dynamic = 'force-dynamic';

export default async function AdminCategoriesPage() {
  const t = await getTranslations('admin');
  await requireAdmin();
  const categories = await listCategories();
  return (
    <AdminPage>
      <AdminPageHeader
        title={t('categories')}
        description={t('categoriesDescription')}
        meta={t('categoryCount', { count: categories.length })}
      />
      <CategoriesPanel categories={categories} />
    </AdminPage>
  );
}
