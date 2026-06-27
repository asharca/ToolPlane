import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getDirectorySkill } from '@/lib/admin/market';
import { listCategories } from '@/lib/admin/categories';
import { updateSkillAction, deleteSkillAction } from '@/lib/admin/market-actions';
import { SkillForm } from '@/components/admin/SkillForm';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

export const dynamic = 'force-dynamic';

export default async function EditSkillPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const [skill, categories] = await Promise.all([getDirectorySkill(id), listCategories()]);
  if (!skill) notFound();

  return (
    <div className="space-y-6 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Edit {skill.name}</h1>
      <SkillForm
        action={updateSkillAction}
        initial={{
          id: skill.id, slug: skill.slug, name: skill.name, author: skill.author, description: skill.description,
          iconUrl: skill.iconUrl, score: skill.score, categoryIds: skill.categories.map((c) => c.id),
        }}
        categories={categories}
        submitLabel="Save changes"
      />
      <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
        <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">Delete</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Refused while any workspace has this skill installed ({skill._count.installs} now).</p>
        <ConfirmDialog label="Delete skill" prompt="Delete this directory entry?" action={deleteSkillAction} hidden={{ id: skill.id }} pendingLabel="Deleting…" />
      </section>
    </div>
  );
}
