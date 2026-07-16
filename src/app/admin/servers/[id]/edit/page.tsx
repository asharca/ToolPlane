import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getDirectoryServer } from '@/lib/admin/market';
import { listCategories } from '@/lib/admin/categories';
import { updateServerAction, deleteServerAction } from '@/lib/admin/market-actions';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';
import { ServerForm } from '@/components/admin/ServerForm';
import { RecipeEditor } from '@/components/admin/RecipeEditor';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { AdminBadge, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';

export const dynamic = 'force-dynamic';

export default async function EditServerPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('admin');
  await requireAdmin();
  const { id } = await params;
  const [server, categories] = await Promise.all([getDirectoryServer(id), listCategories()]);
  if (!server) notFound();
  const recipe = parseServerRecipe(server.installCfg);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={`${t('edit')} ${server.name}`}
        meta={<AdminBadge tone="neutral">/{server.slug}</AdminBadge>}
        backHref="/admin/servers"
        backLabel={t('toolplane')}
      />
      <section className="border-t border-border pt-6" aria-label={`${t('edit')} ${server.name}`}>
        <ServerForm
          action={updateServerAction}
          initial={{
            id: server.id, slug: server.slug, name: server.name, author: server.author, description: server.description,
            iconUrl: server.iconUrl, stars: server.stars, isOfficial: server.isOfficial, isFeatured: server.isFeatured,
            categoryIds: server.categories.map((c) => c.id),
          }}
          categories={categories}
          submitLabel={t('saveChanges')}
        />
      </section>
      <RecipeEditor
        serverId={server.id}
        hasRecipe={!!recipe}
        initial={{
          source: recipe?.source ?? 'npm',
          ref: recipe?.ref ?? '',
          startCommand: recipe?.startCommand ?? '',
          env: (recipe?.env ?? []).join(' '),
          envValues: Object.entries(recipe?.envValues ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
          network: recipe?.network === 'none',
        }}
        verifiedAt={server.verifiedAt ? server.verifiedAt.toISOString() : null}
        verifiedTools={server.verifiedTools ?? null}
      />
      <AdminPanel
        title={t('dangerZone')}
        description={`${t('refusedWhileAnyDeploymentReferencesThisServer')}${server._count.deployments} ${t('now')}`}
        tone="danger"
      >
        <ConfirmDialog label={t('deleteServer')} prompt={t('deleteThisDirectoryEntry')} action={deleteServerAction} hidden={{ id: server.id }} pendingLabel={t('deleting')} tone="danger" />
      </AdminPanel>
    </AdminPage>
  );
}
