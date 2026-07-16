import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getDirectorySkill } from '@/lib/admin/market';
import { listCategories } from '@/lib/admin/categories';
import { updateSkillAction, deleteSkillAction } from '@/lib/admin/market-actions';
import { SkillForm } from '@/components/admin/SkillForm';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { AdminBadge, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';

export const dynamic = 'force-dynamic';

export default async function EditSkillPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('admin');
  await requireAdmin();
  const { id } = await params;
  const [skill, categories] = await Promise.all([getDirectorySkill(id), listCategories()]);
  if (!skill) notFound();

  return (
    <AdminPage className="max-w-4xl">
      <AdminPageHeader
        title={`${t('edit')} ${skill.name}`}
        meta={<AdminBadge tone="neutral">/{skill.slug}</AdminBadge>}
        backHref="/admin/skills"
        backLabel={t('skillsMarket')}
      />
      <section className="border-t border-border pt-6" aria-label={`${t('edit')} ${skill.name}`}>
        <SkillForm
          action={updateSkillAction}
          initial={{
            id: skill.id, slug: skill.slug, name: skill.name, author: skill.author, description: skill.description,
            iconUrl: skill.iconUrl, githubSource: skill.githubSource, score: skill.score, categoryIds: skill.categories.map((c) => c.id),
          }}
          categories={categories}
          submitLabel={t('saveChanges')}
        />
      </section>
      <AdminPanel
        title={t('dangerZone')}
        description={`${t('refusedWhileAnyWorkspaceHasThisSkillInstalled')}${skill._count.installs} ${t('now')}`}
        tone="danger"
      >
        <ConfirmDialog label={t('deleteSkill')} prompt={t('deleteThisDirectoryEntry')} action={deleteSkillAction} hidden={{ id: skill.id }} pendingLabel={t('deleting')} tone="danger" />
      </AdminPanel>
    </AdminPage>
  );
}
