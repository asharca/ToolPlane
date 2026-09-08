import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { History } from 'lucide-react';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';
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

export default async function EditServerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const t = await getTranslations('admin');
  await requireAdmin();
  const { id } = await params;
  const [server, categories] = await Promise.all([getDirectoryServer(id), listCategories()]);
  if (!server) notFound();
  const ops = await getTranslations('adminOps');
  const backHref = adminReturnHref((await searchParams).returnTo, '/admin/servers');
  const recipe = parseServerRecipe(server.installCfg);
  const connectorEnv = new Set([
    ...(recipe?.bearerEnv ? [recipe.bearerEnv] : []),
    ...Object.values(recipe?.headerEnv ?? {}),
  ]);

  return (
    <AdminPage className="max-w-5xl">
      <AdminPageHeader
        title={`${t('edit')} ${server.name}`}
        meta={<AdminBadge tone="neutral">/{server.slug}</AdminBadge>}
        backHref={backHref}
        backLabel={t('toolplane')}
        actions={<Link href={adminHref('/admin/logs', { tab: 'audit', targetType: 'server', targetId: id, returnTo: adminHref(`/admin/servers/${id}/edit`, { returnTo: backHref }) })} className="ui-button-secondary"><History className="size-4" />{ops('audit')}</Link>}
      />
      <section className="border-t border-border pt-6" aria-label={`${t('edit')} ${server.name}`}>
        <ServerForm
          action={updateServerAction}
          initial={{
            id: server.id, slug: server.slug, name: server.name, author: server.author, description: server.description,
            iconUrl: server.iconUrl, stars: server.stars, isOfficial: server.isOfficial, isFeatured: server.isFeatured,
            categoryIds: server.categories.map((c) => c.id), readme: server.readme,
            source: recipe?.source === 'npm' || recipe?.source === 'pypi' || recipe?.source === 'github'
              ? recipe.source
              : undefined,
            sourceRef: recipe?.ref, sourceUrl: recipe?.sourceUrl,
          }}
          categories={categories}
          submitLabel={t('saveChanges')}
          showSourceMetadata={recipe?.source !== 'remote'}
        />
      </section>
      <RecipeEditor
        serverId={server.id}
        hasRecipe={!!recipe}
        initial={{
          source: recipe?.source ?? 'npm',
          ref: recipe?.ref ?? '',
          sourceUrl: recipe?.sourceUrl ?? '',
          startCommand: recipe?.startCommand ?? '',
          env: (recipe?.env ?? []).filter((key) => !connectorEnv.has(key)).join(' '),
          envValues: Object.entries(recipe?.envValues ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
          network: recipe?.network === 'none',
          transport: recipe?.transport,
          authType: recipe?.authType,
          bearerEnv: recipe?.bearerEnv,
          headerEnv: Object.entries(recipe?.headerEnv ?? {})
            .map(([header, envKey]) => `${header}=${envKey}`)
            .join('\n'),
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
