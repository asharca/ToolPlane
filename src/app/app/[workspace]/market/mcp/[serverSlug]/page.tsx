import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Box,
  CheckCircle2,
  ChevronRight,
  FileText,
  Network,
  PackageCheck,
  ShieldCheck,
  Star,
  Wrench,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getMarketServer, getWorkspaceForUser } from '@/lib/workspace/queries';
import { deployServerAction } from '@/lib/workspace/actions';
import { DashboardPage, DashboardPanel } from '@/components/dashboard/DashboardUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export const dynamic = 'force-dynamic';

function ServerIcon({ iconUrl, name }: { iconUrl: string | null; name: string }) {
  return iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={iconUrl} alt="" width={56} height={56} className="size-14 shrink-0 rounded-xl object-cover" />
  ) : (
    <span aria-hidden="true" className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted text-lg font-semibold text-muted-foreground">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

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

  const deploymentHref = server.deploymentId
    ? `/app/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(server.deploymentId)}`
    : null;
  const requiredEnvironmentCount = server.recipe.requiredEnv.length;
  const requiresConfiguration = requiredEnvironmentCount > 0;
  const marketHref = `/app/${encodeURIComponent(slug)}/market/mcp`;

  return (
    <DashboardPage className="space-y-6 lg:space-y-8">
      <Link href={marketHref} className="ui-button-ghost w-fit">
        <ArrowLeft className="size-4" />
        {t('backToMcp')}
      </Link>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-stretch">
        <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex min-w-0 items-start gap-4">
            <ServerIcon iconUrl={server.iconUrl} name={server.name} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{server.name}</h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  <BadgeCheck className="size-3.5" aria-hidden="true" />
                  {t('verified')}
                </span>
                {server.isOfficial ? (
                  <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    {t('official')}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{server.author ?? t('unknownPublisher')}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Star className="size-3.5" aria-hidden="true" />{server.stars.toLocaleString(locale)}</span>
                {typeof server.verifiedTools === 'number' ? (
                  <span className="inline-flex items-center gap-1"><Wrench className="size-3.5" aria-hidden="true" />{t('verifiedTools', { count: server.verifiedTools })}</span>
                ) : null}
              </div>
            </div>
          </div>
          <p className="mt-5 max-w-4xl text-sm leading-7 text-muted-foreground">
            {server.description ?? t('noDescription')}
          </p>
          {server.categories.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {server.categories.map((category) => (
                <Link
                  key={category.slug}
                  href={`${marketHref}?q=${encodeURIComponent(category.name)}`}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {category.name}
                </Link>
              ))}
            </div>
          ) : null}
        </section>

        <aside className="rounded-xl border border-brand/25 bg-brand-soft/45 p-5 sm:p-6">
          {deploymentHref ? (
            <>
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{t('alreadyAddedTitle')}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('alreadyAddedDescription')}</p>
                </div>
              </div>
              <Link href={deploymentHref} className="ui-button-primary mt-5 h-10 w-full">
                {t('manageDeployment')}
                <ArrowRight className="size-4" />
              </Link>
            </>
          ) : (
            <>
              <div className="flex items-start gap-2.5">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{t('readyToDeploy')}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {requiresConfiguration
                      ? t('deploymentNeedsConfiguration', { count: requiredEnvironmentCount })
                      : t('deploymentNoConfiguration')}
                  </p>
                </div>
              </div>
              <form action={deployServerAction} className="mt-5">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="serverId" value={server.id} />
                <SubmitButton flash={false} pendingLabel={t('adding')} className="ui-button-primary h-10 w-full">
                  {t('addToWorkspace')}
                  <ArrowRight className="size-4" />
                </SubmitButton>
              </form>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('deploymentRedirectHint')}</p>
            </>
          )}
        </aside>
      </div>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.78fr)]">
        <DashboardPanel title={t('deploymentRecipe')} description={t('deploymentRecipeDescription')}>
          <dl className="grid gap-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Wrench className="size-3.5" aria-hidden="true" />
                {t('source')}
              </dt>
              <dd className="mt-1.5 font-medium text-foreground">{server.recipe.source}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Network className="size-3.5" aria-hidden="true" />
                {t('network')}
              </dt>
              <dd className="mt-1.5 font-medium text-foreground">
                {server.recipe.network === 'none' ? t('networkNone') : t('networkIsolated')}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Box className="size-3.5" aria-hidden="true" />
                {t('packageReference')}
              </dt>
              <dd className="mt-1.5 break-all rounded-md border border-border bg-muted/35 px-3 py-2 font-mono text-xs text-foreground">
                {server.recipe.ref}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <PackageCheck className="size-3.5" aria-hidden="true" />
                {t('requiredEnvironment')}
              </dt>
              <dd className="mt-2">
                {requiredEnvironmentCount > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {server.recipe.requiredEnv.map((key) => (
                      <code key={key} className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">{key}</code>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">{t('none')}</span>
                )}
              </dd>
            </div>
          </dl>
        </DashboardPanel>

        <DashboardPanel title={t('whatHappensNext')} description={t('deploymentFlowDescription')}>
          <ol className="space-y-4">
            {[
              [t('deploymentStepReviewTitle'), t('deploymentStepReviewDescription')],
              [t('deploymentStepAddTitle'), t('deploymentStepAddDescription')],
              [t('deploymentStepManageTitle'), t('deploymentStepManageDescription')],
            ].map(([title, description], index) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
                </div>
              </li>
            ))}
          </ol>
        </DashboardPanel>
      </section>

      <DashboardPanel title={t('about')}>
        {server.readme ? (
          <details className="group rounded-lg border border-border bg-muted/20" open>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground">
              <span className="inline-flex items-center gap-2"><FileText className="size-4 text-muted-foreground" aria-hidden="true" />{t('readme')}</span>
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
            </summary>
            <pre className="max-h-[38rem] overflow-auto border-t border-border px-4 py-4 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground">
              {server.readme}
            </pre>
          </details>
        ) : (
          <p className="text-sm leading-7 text-muted-foreground">{server.description ?? t('noDescription')}</p>
        )}
      </DashboardPanel>
    </DashboardPage>
  );
}
