import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ChevronRight,
  Search,
  ShieldCheck,
  Star,
} from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getBrowseServers,
  getDeployments,
  getWorkspaceForUser,
  type BrowseServer,
} from '@/lib/workspace/queries';
import { deployServerAction } from '@/lib/workspace/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSection,
  DashboardTable,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function marketHref(workspace: string, input: { q?: string; page?: number }) {
  const query = new URLSearchParams();
  if (input.q) query.set('q', input.q);
  if (input.page && input.page > 1) query.set('page', String(input.page));
  const suffix = query.toString();
  const base = `/app/${encodeURIComponent(workspace)}/market/mcp`;
  return suffix ? `${base}?${suffix}` : base;
}

function McpIcon({
  iconUrl,
  name,
  size = 'md',
}: {
  iconUrl: string | null;
  name: string;
  size?: 'sm' | 'md';
}) {
  const className = size === 'sm'
    ? 'size-5 rounded object-cover'
    : 'size-11 rounded-xl object-cover';
  const fallbackClassName = size === 'sm'
    ? 'size-5 rounded bg-muted'
    : 'flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-sm font-semibold text-muted-foreground';

  return iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={iconUrl} alt="" width={size === 'sm' ? 20 : 44} height={size === 'sm' ? 20 : 44} className={className} />
  ) : (
    <span aria-hidden="true" className={fallbackClassName}>
      {size === 'md' ? name.slice(0, 1).toUpperCase() : null}
    </span>
  );
}

function McpMarketplaceAction({
  workspace,
  server,
  deploymentId,
  t,
  compact = false,
}: {
  workspace: string;
  server: BrowseServer;
  deploymentId: string | null;
  t: Translate;
  compact?: boolean;
}) {
  if (deploymentId) {
    return (
      <Link
        href={`/app/${encodeURIComponent(workspace)}/mcp/${encodeURIComponent(deploymentId)}`}
        className={compact ? 'ui-button-secondary ui-button-sm' : 'ui-button-secondary h-10 w-full'}
      >
        <CheckCircle2 className="size-3.5" />
        {t('manageDeployment')}
      </Link>
    );
  }

  return (
    <form action={deployServerAction} className={compact ? 'inline' : 'w-full'}>
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="serverId" value={server.id} />
      <SubmitButton
        flash={false}
        pendingLabel={t('adding')}
        className={compact ? 'ui-button-primary ui-button-sm' : 'ui-button-primary h-10 w-full'}
      >
        <ArrowRight className="size-3.5" />
        {t('addToWorkspace')}
      </SubmitButton>
    </form>
  );
}

function McpMarketCard({
  workspace,
  server,
  deploymentId,
  locale,
  t,
}: {
  workspace: string;
  server: BrowseServer;
  deploymentId: string | null;
  locale: string;
  t: Translate;
}) {
  const detailHref = `/app/${encodeURIComponent(workspace)}/market/mcp/${encodeURIComponent(server.slug)}`;

  return (
    <article className="ui-panel flex min-w-0 flex-col p-4 sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <McpIcon iconUrl={server.iconUrl} name={server.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={detailHref} className="min-w-0 truncate text-base font-semibold text-foreground hover:underline">
              {server.name}
            </Link>
            {server.isOfficial ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                <BadgeCheck className="size-3" aria-hidden="true" />
                {t('official')}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{server.author ?? t('unknownPublisher')}</p>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
        {server.description ?? t('noDescription')}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t('verifiedRecipe')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Star className="size-3.5" aria-hidden="true" />
          {server.stars.toLocaleString(locale)}
        </span>
        {deploymentId ? (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            {t('addedToWorkspace')}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4">
        <Link href={detailHref} className="ui-button-secondary h-10 w-full">
          {t('viewDetails')}
          <ChevronRight className="size-3.5" />
        </Link>
        <McpMarketplaceAction
          workspace={workspace}
          server={server}
          deploymentId={deploymentId}
          t={t}
        />
      </div>
    </article>
  );
}

export default async function McpMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string | string[]; q?: string | string[] }>;
}) {
  const [{ workspace: slug }, query, t, common, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.market'),
    getTranslations('common'),
    getLocale(),
  ]);
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/mcp`)}`);
  }
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const rawPage = Number(firstParam(query.page));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const q = firstParam(query.q).trim();
  const [{ featured, all, total, pageSize }, deployments] = await Promise.all([
    getBrowseServers(page, q),
    getDeployments(workspace.id),
  ]);
  const deploymentByServerId = new Map(
    deployments.flatMap((deployment) => deployment.serverId
      ? [[deployment.serverId, deployment.id] as const]
      : []),
  );
  const deployedCatalogCount = deploymentByServerId.size;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (page > lastPage) redirect(marketHref(slug, { q, page: lastPage }));

  return (
    <DashboardPage className="space-y-8">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-end">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t('verifiedMcpCatalog')}
          </p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">{t('mcpTitle')}</h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('mcpDescription')}</p>
        </div>
        <div className="rounded-lg border border-brand/20 bg-brand-soft/45 p-4">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('deploymentFlowTitle')}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('deploymentFlowDescription')}</p>
            </div>
          </div>
        </div>
      </div>

      <form className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('searchMcp')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            name="q"
            defaultValue={q}
            placeholder={t('searchMcp')}
            className="ui-input ui-input-icon h-10 w-full"
          />
        </label>
        <button className="ui-button-secondary h-10 sm:min-w-24">{t('search')}</button>
        {q ? (
          <Link href={marketHref(slug, {})} className="ui-button-ghost h-10">
            {t('clearFilters')}
          </Link>
        ) : null}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm">
        <p className="text-muted-foreground">
          {t('mcpResultSummary', { count: total })}
        </p>
        {deployedCatalogCount > 0 ? (
          <Link href={`/app/${encodeURIComponent(slug)}/mcp`} className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            {t('workspaceDeploymentSummary', { count: deployedCatalogCount })}
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      {featured.length > 0 ? (
        <DashboardSection title={t('featuredMcp')}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {featured.map((server) => (
              <McpMarketCard
                key={server.id}
                workspace={slug}
                server={server}
                deploymentId={deploymentByServerId.get(server.id) ?? null}
                locale={locale}
                t={t}
              />
            ))}
          </div>
        </DashboardSection>
      ) : null}

      <DashboardSection title={q ? t('searchResults', { query: q }) : t('allMcp')} count={total}>
        {all.length === 0 ? (
          <DashboardEmptyState
            title={t('noMcpTitle')}
            description={q ? t('noSearchResults', { query: q }) : t('noMcpDescription')}
            actions={q ? <Link href={marketHref(slug, {})} className="ui-button-secondary">{t('clearFilters')}</Link> : undefined}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:hidden">
              {all.map((server) => (
                <McpMarketCard
                  key={server.id}
                  workspace={slug}
                  server={server}
                  deploymentId={deploymentByServerId.get(server.id) ?? null}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>

            <DashboardTable
              className="hidden lg:block"
              headers={[
                { label: t('resource') },
                { label: t('publisher') },
                { label: t('description') },
                { label: t('popularity') },
                { label: t('nextStep'), align: 'right' },
              ]}
              minWidth="58rem"
            >
              {all.map((server) => {
                const deploymentId = deploymentByServerId.get(server.id) ?? null;
                return (
                  <tr key={server.id} className="hover:bg-muted/35">
                    <td className="px-4 py-3.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <McpIcon iconUrl={server.iconUrl} name={server.name} size="sm" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <Link
                              href={`/app/${encodeURIComponent(slug)}/market/mcp/${encodeURIComponent(server.slug)}`}
                              className="truncate font-medium text-foreground hover:underline"
                            >
                              {server.name}
                            </Link>
                            {server.isOfficial ? (
                              <BadgeCheck className="size-4 shrink-0 text-emerald-600" aria-label={t('official')} />
                            ) : null}
                          </div>
                          {deploymentId ? (
                            <span className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="size-3" aria-hidden="true" />
                              {t('addedToWorkspace')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground">{server.author ?? t('unknownPublisher')}</td>
                    <td className="px-4 py-3.5 text-muted-foreground">
                      <span className="line-clamp-2 max-w-xl">{server.description ?? t('noDescription')}</span>
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><Star className="size-3.5" aria-hidden="true" />{server.stars.toLocaleString(locale)}</span>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <div className="inline-flex items-center gap-2">
                        <Link
                          href={`/app/${encodeURIComponent(slug)}/market/mcp/${encodeURIComponent(server.slug)}`}
                          className="text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          {t('viewDetails')}
                        </Link>
                        <McpMarketplaceAction
                          workspace={slug}
                          server={server}
                          deploymentId={deploymentId}
                          t={t}
                          compact
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </DashboardTable>
            <DashboardPagination
              page={page}
              lastPage={lastPage}
              summary={t('paginationSummary', { page, lastPage, total, label: t('mcpResources') })}
              previousLabel={common('previous')}
              nextLabel={common('next')}
              hrefForPage={(nextPage) => marketHref(slug, { q, page: nextPage })}
            />
          </>
        )}
      </DashboardSection>
    </DashboardPage>
  );
}
