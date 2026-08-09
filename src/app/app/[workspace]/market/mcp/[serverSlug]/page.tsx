import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowLeft, BadgeCheck, Box, Network, Star, Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getMarketServer, getWorkspaceForUser } from '@/lib/workspace/queries';
import { deployServerAction } from '@/lib/workspace/actions';
import { DashboardPage, DashboardPanel } from '@/components/dashboard/DashboardUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export const dynamic = 'force-dynamic';

export default async function McpMarketDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; serverSlug: string }>;
}) {
  const [{ workspace: slug, serverSlug }, t, locale] = await Promise.all([
    params,
    getTranslations('console.market'),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/mcp/${serverSlug}`)}`);
  }
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const server = await getMarketServer(serverSlug, workspace.id);
  if (!server) notFound();

  return (
    <DashboardPage className="space-y-6">
      <Link href={`/app/${encodeURIComponent(slug)}/market/mcp`} className="ui-button-ghost w-fit">
        <ArrowLeft className="size-4" />
        {t('backToMcp')}
      </Link>

      <div className="flex flex-col gap-5 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {server.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={server.iconUrl} alt="" width={56} height={56} className="size-14 rounded-xl object-cover" />
          ) : (
            <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted"><Box className="size-6 text-muted-foreground" /></span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">{server.name}</h2>
              <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                <BadgeCheck className="size-3.5" />{t('verified')}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{server.author ?? t('unknownPublisher')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Star className="size-3.5" />{server.stars.toLocaleString(locale)}</span>
              {typeof server.verifiedTools === 'number' ? <span>{t('verifiedTools', { count: server.verifiedTools })}</span> : null}
              {server.isOfficial ? <span>{t('official')}</span> : null}
            </div>
          </div>
        </div>
        {server.deploymentId ? (
          <Link href={`/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(server.deploymentId)}`} className="ui-button-secondary shrink-0">
            {t('manageDeployment')}
          </Link>
        ) : (
          <form action={deployServerAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="serverId" value={server.id} />
            <SubmitButton pendingLabel={t('adding')} className="ui-button-primary shrink-0">{t('addToWorkspace')}</SubmitButton>
          </form>
        )}
      </div>

      {server.description ? <p className="max-w-4xl text-sm leading-7 text-muted-foreground">{server.description}</p> : null}

      {server.categories.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {server.categories.map((category) => (
            <Link
              key={category.slug}
              href={`/app/${encodeURIComponent(slug)}/market/mcp?q=${encodeURIComponent(category.name)}`}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <DashboardPanel title={t('deploymentRecipe')} description={t('deploymentRecipeDescription')} className="lg:col-span-1">
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Wrench className="size-3.5" />{t('source')}</dt>
              <dd className="mt-1 font-medium text-foreground">{server.recipe.source}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Box className="size-3.5" />{t('packageReference')}</dt>
              <dd className="mt-1 break-all font-mono text-xs text-foreground">{server.recipe.ref}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Network className="size-3.5" />{t('network')}</dt>
              <dd className="mt-1 font-medium text-foreground">{server.recipe.network === 'none' ? t('networkNone') : t('networkIsolated')}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('requiredEnvironment')}</dt>
              <dd className="mt-2 flex flex-wrap gap-1.5">
                {server.recipe.requiredEnv.length > 0 ? server.recipe.requiredEnv.map((key) => (
                  <code key={key} className="rounded bg-muted px-2 py-1 text-xs text-foreground">{key}</code>
                )) : <span className="text-muted-foreground">{t('none')}</span>}
              </dd>
            </div>
          </dl>
        </DashboardPanel>

        <DashboardPanel title={t('about')} className="lg:col-span-2">
          {server.readme ? (
            <pre className="max-h-[38rem] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground">{server.readme}</pre>
          ) : (
            <p className="text-sm leading-7 text-muted-foreground">{server.description ?? t('noDescription')}</p>
          )}
        </DashboardPanel>
      </div>
    </DashboardPage>
  );
}
