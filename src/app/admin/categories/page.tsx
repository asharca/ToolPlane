import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { CategoriesPanel } from '@/components/admin/CategoriesPanel';

export const dynamic = 'force-dynamic';

export default async function AdminCategoriesPage() {
  await requireAdmin();
  const categories = await listCategories();
  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Categories</h1>
      <CategoriesPanel categories={categories} />
    </div>
  );
}
