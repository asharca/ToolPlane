import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { getDirectoryServer } from '@/lib/admin/market';
import { listCategories } from '@/lib/admin/categories';
import { updateServerAction, deleteServerAction } from '@/lib/admin/market-actions';
import { parseServerRecipe } from '@/lib/workspace/server-recipe';
import { ServerForm } from '@/components/admin/ServerForm';
import { RecipeEditor } from '@/components/admin/RecipeEditor';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';

export const dynamic = 'force-dynamic';

export default async function EditServerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const [server, categories] = await Promise.all([getDirectoryServer(id), listCategories()]);
  if (!server) notFound();
  const recipe = parseServerRecipe(server.installCfg);

  return (
    <div className="space-y-6 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">Edit {server.name}</h1>
      <ServerForm
        action={updateServerAction}
        initial={{
          id: server.id, slug: server.slug, name: server.name, author: server.author, description: server.description,
          iconUrl: server.iconUrl, stars: server.stars, isOfficial: server.isOfficial, isFeatured: server.isFeatured,
          categoryIds: server.categories.map((c) => c.id),
        }}
        categories={categories}
        submitLabel="Save changes"
      />
      <RecipeEditor
        serverId={server.id}
        hasRecipe={!!recipe}
        initial={{
          source: recipe?.source ?? 'npm',
          ref: recipe?.ref ?? '',
          startCommand: recipe?.startCommand ?? '',
          env: (recipe?.env ?? []).join(' '),
          network: recipe?.network === 'none',
        }}
        verifiedAt={server.verifiedAt ? server.verifiedAt.toISOString() : null}
        verifiedTools={server.verifiedTools ?? null}
      />
      <section className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
        <h2 className="mb-1 text-sm font-semibold text-red-700 dark:text-red-400">Delete</h2>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Refused while any deployment references this server ({server._count.deployments} now).</p>
        <ConfirmDialog label="Delete server" prompt="Delete this directory entry?" action={deleteServerAction} hidden={{ id: server.id }} pendingLabel="Deleting…" />
      </section>
    </div>
  );
}
