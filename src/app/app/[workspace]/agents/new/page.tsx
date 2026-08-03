import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Bot, CopyPlus, PackageCheck, Server, Wrench } from 'lucide-react';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSearchForm,
  DashboardSection,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';
import { clonePublicAgentAction } from '@/lib/agents/actions';
import { listPublicAgentListings } from '@/lib/agents/market';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';

export const dynamic = 'force-dynamic';

function cloneErrorMessage(
  t: Awaited<ReturnType<typeof getTranslations<'agentMarket'>>>,
  error?: string,
) {
  if (!error) return null;
  if (error === 'release_not_found' || error === 'listing_unavailable') return t('releaseUnavailable');
  return t('invalidInstall');
}

export default async function BrowseAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; q?: string; cloneError?: string }>;
}) {
  const [{ workspace: slug }, { page: pageParam, q: qParam, cloneError: cloneErrorParam }, t, market] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.agents'),
    getTranslations('agentMarket'),
  ]);
  const page = Math.max(1, Number(pageParam) || 1);
  const q = (qParam ?? '').trim();
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const { items, total, pageSize } = await listPublicAgentListings({ page, q });
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const returnTo = `/app/${slug}/agents/new`;
  const cloneError = cloneErrorMessage(market, cloneErrorParam);

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: t('title'), href: `/app/${slug}/agents` }, { label: market('market') }]}
      />
      <DashboardPage>
        <DashboardToolbar
          actions={(
            <Link href={`/app/${slug}/agents`} className="ui-button-ghost">
              {t('title')}
            </Link>
          )}
        >
          <DashboardSearchForm
            defaultValue={q}
            placeholder={market('searchPlaceholder')}
            clearHref={`/app/${slug}/agents/new`}
          />
        </DashboardToolbar>

        {cloneError ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            {cloneError}
          </p>
        ) : null}

        <DashboardSection title={q ? market('searchResults', { query: q }) : market('communityAgents')} count={total}>
          {items.length === 0 ? (
            <DashboardEmptyState
              icon={Bot}
              title={q ? market('noSearchResultsTitle') : market('emptyTitle')}
              description={q ? market('noSearchResultsDescription') : market('emptyDescription')}
            />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {items.map((item) => {
                const preferredModel = item.releaseSummary.models[0]?.model ?? market('bringYourOwnModel');
                const runtimeLabel = item.releaseSummary.runtimes
                  .map((runtime) => runtime === 'hermes' ? market('hermesRuntime') : market('nativeRuntime'))
                  .join(' + ');
                return (
                  <article key={item.id} className="ui-panel p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{item.workspaceName}</span>
                          <span>/</span>
                          <span>{market('version', { version: item.latestVersion })}</span>
                        </div>
                        <h2 className="truncate text-lg font-semibold text-foreground">{item.name}</h2>
                        <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                          {item.summary ?? market('notSpecified')}
                        </p>
                      </div>
                      <form action={clonePublicAgentAction} className="shrink-0">
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="releaseId" value={item.latestReleaseId} />
                        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <SubmitButton
                          pendingLabel={market('cloningAgent')}
                          savedLabel={market('cloneAgent')}
                          flash={false}
                          className="ui-button-primary ui-button-sm"
                        >
                          <CopyPlus className="size-4" />
                          {market('cloneAgent')}
                        </SubmitButton>
                      </form>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-md border border-border bg-muted/35 p-3">
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                          <Bot className="size-3.5" /> {t('agents')}
                        </div>
                        <p className="text-sm font-medium text-foreground">{item.releaseSummary.agentCount}</p>
                      </div>
                      <div className="rounded-md border border-border bg-muted/35 p-3">
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                          <Server className="size-3.5" /> {t('mcp')}
                        </div>
                        <p className="text-sm font-medium text-foreground">{item.releaseSummary.deploymentCount}</p>
                      </div>
                      <div className="rounded-md border border-border bg-muted/35 p-3">
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                          <PackageCheck className="size-3.5" /> {t('skills')}
                        </div>
                        <p className="text-sm font-medium text-foreground">{item.releaseSummary.skillCount}</p>
                      </div>
                      <div className="rounded-md border border-border bg-muted/35 p-3">
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                          <Wrench className="size-3.5" /> {t('toolkits')}
                        </div>
                        <p className="text-sm font-medium text-foreground">{item.releaseSummary.toolkitCount}</p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{market('runtime')}: {runtimeLabel}</span>
                      <span>{market('model')}: {preferredModel}</span>
                      <span>{market('cloneCount', { count: item.installCount })}</span>
                    </div>
                    {item.tags.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {item.tags.map((tag) => (
                          <span key={tag} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </DashboardSection>

        <DashboardPagination
          page={page}
          lastPage={lastPage}
          total={total}
          label={t('agents')}
          hrefForPage={(nextPage) => `/app/${slug}/agents/new?${q ? `q=${encodeURIComponent(q)}&` : ''}page=${nextPage}`}
        />
      </DashboardPage>
    </>
  );
}
