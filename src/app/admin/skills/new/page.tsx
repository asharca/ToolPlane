import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { listCategories } from '@/lib/admin/categories';
import { createSkillAction } from '@/lib/admin/market-actions';
import { SkillForm } from '@/components/admin/SkillForm';
import { AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';

export const dynamic = 'force-dynamic';

export default async function NewSkillPage() {
  const t = await getTranslations('admin');
  await requireAdmin();
  const categories = await listCategories();
  return (
    <AdminPage className="max-w-4xl">
      <AdminPageHeader
        title={t('addSkill')}
        backHref="/admin/skills"
        backLabel={t('skillsMarket')}
      />
      <section className="border-t border-border pt-6" aria-label={t('addSkill')}>
        <SkillForm
          action={createSkillAction}
          initial={{}}
          categories={categories}
          submitLabel={t('create')}
        />
      </section>
    </AdminPage>
  );
}
