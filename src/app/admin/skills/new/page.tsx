import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { createSkillAction } from '@/lib/admin/market-actions';
import { SkillForm } from '@/components/admin/SkillForm';

export const dynamic = 'force-dynamic';

export default async function NewSkillPage() {
  const t = await getTranslations('admin');
  await requireAdmin();
  const categories = await listCategories();
  return (
    <div className="space-y-4 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t('addSkill')}</h1>
      <SkillForm action={createSkillAction} initial={{}} categories={categories} submitLabel="Create" />
    </div>
  );
}
