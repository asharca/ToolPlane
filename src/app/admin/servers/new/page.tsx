import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { createServerAction } from '@/lib/admin/market-actions';
import { ServerForm } from '@/components/admin/ServerForm';

export const dynamic = 'force-dynamic';

export default async function NewServerPage() {
  await requireAdmin();
  const categories = await listCategories();
  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Add server</h1>
      <ServerForm action={createServerAction} initial={{}} categories={categories} submitLabel="Create" />
    </div>
  );
}
