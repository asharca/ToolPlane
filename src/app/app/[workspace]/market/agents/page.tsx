import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowRight, Bot, Container, Copy, PackageCheck, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  listAgentMarketCategories,
  listAgentMarketListings,
} from '@/lib/agents/market';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
} from '@/components/dashboard/DashboardUI';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { MarketCategorySidebar } from '@/components/dashboard/market/MarketCategorySidebar';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;
type MarketSort = 'popular' | 'newest' | 'name';

type SearchParams = {
  page?: string | string[];
  q?: string | string[];
  category?: string | string[];
  sort?: string | string[];
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function marketHref(
  workspace: string,
  input: { q?: string; page?: number; category?: string; sort?: MarketSort },
) {
  const params = new URLSearchParams();
  if (input.q) params.set('q', input.q);
  if (input.category) params.set('category', input.category);
  if (input.sort && input.sort !== 'popular') params.set('sort', input.sort);
  if (input.page && input.page > 1) params.set('page', String(input.page));
  const query = params.toString();
  const base = `/app/${encodeURIComponent(workspace)}/market/agents`;
  return query ? `${base}?${query}` : base;
}

function avatarLabel(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? 'A';
}

export default async function AgentMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ workspace: slug }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslations('agentMarket'),
  ]);
  const user = await getCurrentUser();
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/agents`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const rawPage = Number(firstParam(query.page));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const q = firstParam(query.q).trim();
  const category = firstParam(query.category).trim();
  const requestedSort = firstParam(query.sort);
  const sort: MarketSort = requestedSort === 'newest' || requestedSort === 'name'
    ? requestedSort
    : 'popular';
  const [categories, result] = await Promise.all([
    listAgentMarketCategories(),
    listAgentMarketListings({ page, pageSize: PAGE_SIZE, q, category, sort }),
  ]);
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  if (category && !categories.some((item) => item.slug === category)) {
    redirect(marketHref(slug, { q, sort }));
  }
  if (page > totalPages) {
    redirect(marketHref(slug, { q, category, sort, page: totalPages }));
  }
  const hasFilters = Boolean(q || category || sort !== 'popular');
  const sortedCategories = [...categories].sort((a, b) => (
    b._count.agentListings - a._count.agentListings || a.name.localeCompare(b.name)
  ));

  return (
    <DashboardPage className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold text-foreground">{t('communityAgents')}</h2>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('heroDescription')}</p>
      </div>

      <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_10rem_auto]">
        <input type="hidden" name="category" value={category} />
        <label className="relative min-w-0 sm:col-span-2 lg:col-span-1">
          <span className="sr-only">{t('searchPlaceholder')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            name="q"
            defaultValue={q}
            placeholder={t('searchPlaceholder')}
            className="ui-input ui-input-icon h-10 w-full"
          />
        </label>
        <NativeSelect name="sort" defaultValue={sort} aria-label={t('sortLabel')} className="ui-input h-10">
          <option value="popular">{t('mostCloned')}</option>
          <option value="newest">{t('newest')}</option>
          <option value="name">{t('sortName')}</option>
        </NativeSelect>
        <button className="ui-button-secondary h-10">
          <SlidersHorizontal className="size-4" />
          {t('sortLabel')}
        </button>
      </form>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <MarketCategorySidebar
          label={t('popularUses')}
          allLabel={t('browseAll')}
          allHref={marketHref(slug, { q, sort })}
          allCount={result.availableTotal ?? result.total}
          allActive={!category}
          categories={sortedCategories.map((item) => ({
            name: item.name,
            count: item._count.agentListings,
            active: item.slug === category,
            href: marketHref(slug, { q, sort, category: item.slug === category ? undefined : item.slug }),
          }))}
        />

        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{t('resultCount', { count: result.total })}</span>
            {hasFilters ? (
              <Link href={marketHref(slug, {})} className="font-medium text-foreground hover:underline">
                {t('clearFilters')}
              </Link>
            ) : null}
          </div>

          {result.items.length === 0 ? (
            <DashboardEmptyState
              icon={Bot}
              title={hasFilters ? t('noSearchResultsTitle') : t('emptyTitle')}
              description={hasFilters ? t('noSearchResultsDescription') : t('emptyDescription')}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {result.items.map((agent) => {
                const detailHref = `/app/${encodeURIComponent(slug)}/market/agents/${encodeURIComponent(agent.id)}`;
                return (
                  <article key={agent.id} className="ui-panel flex min-w-0 flex-col p-4">
                <div className="flex items-start gap-3">
                  {agent.iconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={agent.iconUrl} alt="" width={44} height={44} className="size-11 rounded-lg object-cover" />
                  ) : (
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand-soft font-semibold text-accent-foreground">
                      {avatarLabel(agent.name)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      href={detailHref}
                      className="line-clamp-1 font-semibold text-foreground hover:underline"
                    >
                      {agent.name}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {agent.author ?? agent.workspaceName ?? agent.workspaceSlug ?? ''}
                    </p>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
                  {agent.summary}
                </p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {agent.categories.slice(0, 2).map((item) => (
                    <Link
                      key={item.slug}
                      href={marketHref(slug, { category: item.slug, sort })}
                      className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {item.name}
                    </Link>
                  ))}
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-4 text-[11px] text-muted-foreground">
                  <div className="min-w-0">
                    <dt className="flex items-center gap-1"><PackageCheck className="size-3.5 shrink-0" />{t('resources')}</dt>
                    <dd className="mt-1 font-semibold text-foreground">{agent.releaseSummary.resourceCount}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="flex items-center gap-1"><Container className="size-3.5 shrink-0" />{t('sandboxes')}</dt>
                    <dd className="mt-1 font-semibold text-foreground">{agent.releaseSummary.agentCount}</dd>
                  </div>
                  <div className="min-w-0 text-right">
                    <dt className="flex items-center justify-end gap-1"><Copy className="size-3.5 shrink-0" />{t('clones')}</dt>
                    <dd className="mt-1 font-semibold text-foreground">{agent.installCount}</dd>
                  </div>
                </dl>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Link href={detailHref} className="ui-button-secondary h-9 min-w-0 px-3">
                    {t('viewDetails')} <ArrowRight className="size-4" />
                  </Link>
                  <Link href={`${detailHref}#install`} className="ui-button-primary h-9 min-w-0 px-3">
                    <Plus className="size-4" /> {t('addAgent')}
                  </Link>
                </div>
                  </article>
                );
              })}
            </div>
          )}

          <DashboardPagination
            page={result.page}
            lastPage={totalPages}
            summary={t('pageOf', { page: result.page, total: totalPages })}
            previousLabel={t('previous')}
            nextLabel={t('next')}
            hrefForPage={(nextPage) => marketHref(slug, { q, category, sort, page: nextPage })}
          />
        </div>
      </div>
    </DashboardPage>
  );
}
