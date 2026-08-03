import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Bot, Copy, Network, PackageCheck, Search, SlidersHorizontal } from 'lucide-react';
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
  if (page > totalPages) {
    redirect(marketHref(slug, { q, category, sort, page: totalPages }));
  }
  const hasFilters = Boolean(q || category || sort !== 'popular');

  return (
    <DashboardPage className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('communityAgents')}</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('heroDescription')}</p>
      </div>

      <form className="grid gap-2 rounded-lg border border-border bg-card p-3 md:grid-cols-[minmax(14rem,1fr)_11rem_10rem_auto]">
        <label className="relative min-w-0">
          <span className="sr-only">{t('searchPlaceholder')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            name="q"
            defaultValue={q}
            placeholder={t('searchPlaceholder')}
            className="ui-input ui-input-icon h-10 w-full"
          />
        </label>
        <NativeSelect name="category" defaultValue={category} aria-label={t('popularUses')} className="ui-input h-10">
          <option value="">{t('browseAll')}</option>
          {categories.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.name} ({item._count.agentListings})
            </option>
          ))}
        </NativeSelect>
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

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {result.items.map((agent) => (
            <article key={agent.id} className="ui-panel flex min-w-0 flex-col p-5">
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
                    href={`/app/${encodeURIComponent(slug)}/market/agents/${encodeURIComponent(agent.id)}`}
                    className="line-clamp-1 font-semibold text-foreground hover:underline"
                  >
                    {agent.name}
                  </Link>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {agent.author ?? agent.workspaceName ?? agent.workspaceSlug ?? ''}
                  </p>
                </div>
              </div>
              <p className="mt-4 line-clamp-3 min-h-[3.75rem] text-sm leading-5 text-muted-foreground">
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
              <div className="mt-5 grid grid-cols-3 gap-2 border-t border-border pt-4 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><PackageCheck className="size-3.5" />{agent.releaseSummary.resourceCount}</span>
                <span className="inline-flex items-center gap-1"><Network className="size-3.5" />{agent.releaseSummary.subAgentCount}</span>
                <span className="inline-flex items-center justify-end gap-1"><Copy className="size-3.5" />{agent.installCount}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      <DashboardPagination
        page={result.page}
        lastPage={totalPages}
        total={result.total}
        label={t('communityAgents')}
        hrefForPage={(nextPage) => marketHref(slug, { q, category, sort, page: nextPage })}
      />
    </DashboardPage>
  );
}
