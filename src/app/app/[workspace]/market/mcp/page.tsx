import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { BadgeCheck, Search, Star } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getBrowseServers,
  getDeployments,
  getWorkspaceForUser,
} from '@/lib/workspace/queries';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { deployServerAction } from '@/lib/workspace/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSection,
  DashboardTable,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

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
  const deployedIds = new Set(
    deployments.map((deployment) => deployment.serverId).filter((id): id is string => Boolean(id)),
  );
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (page > lastPage) redirect(marketHref(slug, { q, page: lastPage }));

  return (
    <DashboardPage className="space-y-8">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{t('mcpTitle')}</h2>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('mcpDescription')}</p>
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
        <button className="ui-button-secondary h-10">{t('search')}</button>
        {q ? (
          <Link href={marketHref(slug, {})} className="ui-button-ghost h-10">
            {t('clearFilters')}
          </Link>
        ) : null}
      </form>

      {featured.length > 0 ? (
        <DashboardSection title={t('featuredMcp')}>
          <BrowseGrid
            items={featured}
            installedIds={deployedIds}
            slug={slug}
            action={deployServerAction}
            idField="serverId"
            actionLabel={t('add')}
            installedLabel={t('added')}
            detailKind="mcp"
          />
        </DashboardSection>
      ) : null}

      <DashboardSection title={q ? t('searchResults', { query: q }) : t('allMcp')} count={total}>
        {all.length === 0 ? (
          <DashboardEmptyState
            title={t('noMcpTitle')}
            description={q ? t('noSearchResults', { query: q }) : t('noMcpDescription')}
          />
        ) : (
          <>
            <DashboardTable
              headers={[
                { label: t('resource') },
                { label: t('publisher') },
                { label: t('description') },
                { label: t('popularity') },
                { align: 'right' },
              ]}
              minWidth="52rem"
            >
              {all.map((server) => (
                <tr key={server.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      {server.iconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={server.iconUrl} alt="" width={20} height={20} className="size-5 rounded object-cover" />
                      ) : (
                        <span className="size-5 rounded bg-muted" />
                      )}
                      <Link
                        href={`/app/${encodeURIComponent(slug)}/market/mcp/${encodeURIComponent(server.slug)}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {server.name}
                      </Link>
                      {server.isOfficial ? (
                        <BadgeCheck className="size-4 text-emerald-600" aria-label={t('official')} />
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{server.author ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="line-clamp-1">{server.description ?? t('noDescription')}</span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><Star className="size-3.5" />{server.stars.toLocaleString(locale)}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {deployedIds.has(server.id) ? (
                      <span className="text-xs text-muted-foreground">{t('added')}</span>
                    ) : (
                      <form action={deployServerAction} className="inline">
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="serverId" value={server.id} />
                        <button className="text-xs font-medium text-foreground hover:text-muted-foreground">{t('add')}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
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
