import Link from 'next/link';
import { ArrowRight, LockKeyhole, Search, Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import {
  AgentMarketEmptyCard,
  AgentMarketRow,
  FeaturedAgentCard,
  type AgentMarketCardData,
  type AgentMarketCardLabels,
} from '@/components/agents/AgentMarketCard';
import { listPublicAgentListings } from '@/lib/agents/market';

export const dynamic = 'force-dynamic';

type MarketSearchParams = {
  page?: string;
  q?: string;
  sort?: string;
};

function marketHref(input: { q?: string; page?: number; sort?: string }) {
  const params = new URLSearchParams();
  if (input.q) params.set('q', input.q);
  if (input.page && input.page > 1) params.set('page', String(input.page));
  if (input.sort && input.sort !== 'popular') params.set('sort', input.sort);
  const query = params.toString();
  return query ? `/agents?${query}` : '/agents';
}

function toCardData(
  item: Awaited<ReturnType<typeof listPublicAgentListings>>['items'][number],
  runtimeLabels: { native: string; hermes: string },
): AgentMarketCardData {
  const preferredModel = item.releaseSummary.models[0]?.model ?? null;
  const runtime = item.releaseSummary.runtimes
    .map((kind) => kind === 'hermes' ? runtimeLabels.hermes : runtimeLabels.native)
    .join(' + ');
  return {
    slug: item.slug,
    name: item.name,
    summary: item.summary,
    workspaceName: item.workspaceName,
    workspaceSlug: item.workspaceSlug,
    tags: item.tags,
    cloneCount: item.installCount,
    model: preferredModel,
    runtime,
    agentCount: item.releaseSummary.agentCount,
    serverCount: item.releaseSummary.deploymentCount,
    skillCount: item.releaseSummary.skillCount,
  };
}

function popularTags(items: AgentMarketCardData[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6);
}

export default async function AgentMarketPage({
  searchParams,
}: {
  searchParams: Promise<MarketSearchParams>;
}) {
  const { page: pageParam, q: qParam, sort: sortParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const q = (qParam ?? '').trim();
  const sort = sortParam === 'newest' ? 'newest' : 'popular';
  const [t, result] = await Promise.all([
    getTranslations('agentMarket'),
    listPublicAgentListings({ page, q, sort }),
  ]);
  const runtimeLabels = {
    native: t('nativeRuntime'),
    hermes: t('hermesRuntime'),
  };
  const cards = result.items.map((item) => toCardData(item, runtimeLabels));
  const featured = cards[0] ?? null;
  const rest = featured ? cards.slice(1) : [];
  const tags = popularTags(cards);
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  const cardLabels: AgentMarketCardLabels = {
    model: t('model'),
    runtime: t('runtime'),
    bringYourOwn: t('bringYourOwnModel'),
    mcpSkills: t('mcpSkills'),
    clones: t('clones'),
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
      <section className="grid gap-10 py-12 sm:py-16 lg:grid-cols-[minmax(0,0.92fr)_minmax(22rem,1.08fr)] lg:gap-16 lg:py-20">
        <div>
          <h1 className="max-w-3xl text-balance text-5xl font-semibold tracking-[-0.04em] text-foreground sm:text-6xl">
            {t('heroTitle')}
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-muted-foreground">
            {t('heroDescription')}
          </p>
        </div>

        <div className="flex flex-col justify-between gap-8">
          <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 border-t border-foreground pt-4 text-sm leading-6">
            <LockKeyhole className="mt-0.5 size-4 text-foreground" />
            <div>
              <strong className="block text-foreground">{t('safetyTitle')}</strong>
              <span className="text-muted-foreground">{t('safetyDescription')}</span>
            </div>
          </div>
          <form action="/agents" className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className="ui-input h-12 w-full bg-card pl-10 pr-4"
            />
            <input type="hidden" name="sort" value={sort} />
          </form>
        </div>
      </section>

      <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-y border-border">
        <nav className="flex self-stretch" aria-label={t('sortLabel')}>
          {([
            ['popular', t('mostCloned')],
            ['newest', t('newest')],
          ] as const).map(([value, label]) => (
            <Link
              key={value}
              href={marketHref({ q, sort: value })}
              aria-current={sort === value ? 'page' : undefined}
              className={`inline-flex items-center border-b-2 px-4 text-sm font-semibold transition-colors sm:px-5 ${
                sort === value
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <p className="px-1 text-xs text-muted-foreground">
          {t('resultCount', { count: result.total })}
        </p>
      </div>

      <section className="grid gap-8 py-8 sm:py-10 lg:grid-cols-[minmax(0,1.45fr)_minmax(17rem,0.55fr)]">
        <div className="min-w-0">
          <div className="mb-4 flex items-end justify-between gap-4">
            <h2 className="text-base font-semibold text-foreground">
              {q ? t('searchResults', { query: q }) : t('communityAgents')}
            </h2>
            {q ? (
              <Link href={marketHref({ sort })} className="text-xs text-muted-foreground hover:text-foreground">
                {t('clearSearch')}
              </Link>
            ) : null}
          </div>

          {featured ? (
            <>
              <FeaturedAgentCard agent={featured} labels={cardLabels} />
              {rest.length > 0 ? (
                <div className="mt-3 border-t border-border">
                  {rest.map((agent) => <AgentMarketRow key={`${agent.workspaceSlug}/${agent.slug}`} agent={agent} />)}
                </div>
              ) : null}
            </>
          ) : (
            <AgentMarketEmptyCard
              title={q ? t('noSearchResultsTitle') : t('emptyTitle')}
              description={q ? t('noSearchResultsDescription') : t('emptyDescription')}
            />
          )}

          {lastPage > 1 ? (
            <nav className="mt-8 flex items-center justify-between border-t border-border pt-5" aria-label={t('pagination')}>
              {page > 1 ? (
                <Link href={marketHref({ q, sort, page: page - 1 })} className="ui-button-secondary">
                  {t('previous')}
                </Link>
              ) : <span />}
              <span className="text-xs text-muted-foreground">
                {t('pageOf', { page, total: lastPage })}
              </span>
              {page < lastPage ? (
                <Link href={marketHref({ q, sort, page: page + 1 })} className="ui-button-secondary">
                  {t('next')}
                </Link>
              ) : <span />}
            </nav>
          ) : null}
        </div>

        <aside className="space-y-4">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-base font-semibold text-foreground">{t('popularUses')}</h2>
          </div>
          {tags.length > 0 ? (
            <div className="divide-y divide-border border-y border-border">
              {tags.map(([tag, count]) => (
                <Link
                  key={tag}
                  href={marketHref({ q: tag, sort })}
                  className="group flex items-center justify-between gap-4 py-4 text-sm"
                >
                  <span className="font-medium text-foreground group-hover:underline">{tag}</span>
                  <span className="text-xs text-muted-foreground">{t('agentCount', { count })}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="border-y border-border py-5 text-sm leading-6 text-muted-foreground">
              {t('tagsAppearAfterPublishing')}
            </p>
          )}

          <div className="mt-6 rounded-lg bg-brand-soft p-5 text-accent-foreground">
            <Sparkles className="size-5" />
            <h2 className="mt-4 text-base font-semibold">{t('publishCtaTitle')}</h2>
            <p className="mt-2 text-sm leading-6 text-accent-foreground/80">{t('publishCtaDescription')}</p>
            <Link href="/app" className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold hover:underline">
              {t('openConsole')} <ArrowRight className="size-4" />
            </Link>
          </div>
        </aside>
      </section>
    </div>
  );
}
