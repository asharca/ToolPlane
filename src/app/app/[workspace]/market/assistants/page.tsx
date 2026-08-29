import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowRight, Copy, MessageCircle, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listMarketListingCategories, listMarketListings } from '@/lib/market/listings';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { DashboardEmptyState, DashboardPage, DashboardPagination } from '@/components/dashboard/DashboardUI';
import { MarketCategorySidebar } from '@/components/dashboard/market/MarketCategorySidebar';
import { NativeSelect } from '@/components/ui/NativeSelect';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;
type MarketSort = 'popular' | 'newest' | 'name';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function marketHref(
  workspace: string,
  input: { q?: string; category?: string; sort?: MarketSort; page?: number },
) {
  const query = new URLSearchParams();
  if (input.q) query.set('q', input.q);
  if (input.category) query.set('category', input.category);
  if (input.sort && input.sort !== 'popular') query.set('sort', input.sort);
  if (input.page && input.page > 1) query.set('page', String(input.page));
  const suffix = query.toString();
  const base = `/app/${encodeURIComponent(workspace)}/market/assistants`;
  return suffix ? `${base}?${suffix}` : base;
}

export default async function AssistantMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
    category?: string | string[];
    sort?: string | string[];
  }>;
}) {
  const [{ workspace: slug }, query, t, common, user] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.market'),
    getTranslations('common'),
    getCurrentUser(),
  ]);
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/assistants`)}`);
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const rawPage = Number(firstParam(query.page));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const q = firstParam(query.q).trim();
  const category = firstParam(query.category).trim().toLocaleLowerCase();
  const requestedSort = firstParam(query.sort);
  const sort: MarketSort = requestedSort === 'newest' || requestedSort === 'name'
    ? requestedSort
    : 'popular';
  const [categories, result] = await Promise.all([
    listMarketListingCategories('assistant'),
    listMarketListings({ kind: 'assistant', q, category, sort, page, pageSize: PAGE_SIZE }),
  ]);
  if (category && !categories.some((item) => item.slug === category)) {
    redirect(marketHref(slug, { q, sort }));
  }
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  if (page > lastPage) redirect(marketHref(slug, { q, category, sort, page: lastPage }));
  const hasFilters = Boolean(q || category || sort !== 'popular');

  return (
    <DashboardPage className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-foreground">{t('assistantsTitle')}</h2>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('assistantsMarketDescription')}</p>
      </div>

      <form className="flex w-full flex-col gap-2 sm:flex-row">
        <input type="hidden" name="category" value={category} />
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('searchAssistants')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input name="q" defaultValue={q} placeholder={t('searchAssistants')} className="ui-input ui-input-icon h-10 w-full" />
        </label>
        <NativeSelect name="sort" defaultValue={sort} aria-label={t('sortResources')} className="ui-input h-10 sm:w-40">
          <option value="popular">{t('sortPopular')}</option>
          <option value="newest">{t('sortNewest')}</option>
          <option value="name">{t('sortName')}</option>
        </NativeSelect>
        <button className="ui-button-secondary h-10"><SlidersHorizontal className="size-4" />{t('applyFilters')}</button>
      </form>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <MarketCategorySidebar
          label={t('filterByCategory')}
          allLabel={t('allCategories')}
          allHref={marketHref(slug, { q, sort })}
          allCount={result.availableTotal}
          allActive={!category}
          categories={categories.map((item) => ({
            name: item.name,
            count: item.count,
            active: item.slug === category,
            href: marketHref(slug, { q, sort, category: item.slug === category ? undefined : item.slug }),
          }))}
        />

        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{t('assistantResultSummary', { count: result.total })}</span>
            {hasFilters ? (
              <Link href={marketHref(slug, {})} className="font-medium text-foreground hover:underline">{t('clearFilters')}</Link>
            ) : null}
          </div>

          {result.items.length === 0 ? (
            <DashboardEmptyState
              icon={MessageCircle}
              title={t('noAssistantsTitle')}
              description={hasFilters ? t('noAssistantsMatchFilters') : t('noAssistantsDescription')}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {result.items.map((assistant) => {
                if (!assistant.latestRelease) return null;
                const detailHref = `/app/${encodeURIComponent(slug)}/market/assistants/${encodeURIComponent(assistant.namespace)}/${encodeURIComponent(assistant.slug)}`;
                const createHref = `/app/${encodeURIComponent(slug)}/chat?newAssistant=1&template=${encodeURIComponent(assistant.latestRelease.id)}`;
                return (
                  <article key={assistant.id} className="ui-panel flex min-w-0 flex-col p-4">
                    <div className="flex min-w-0 items-start gap-3">
                      {assistant.iconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={assistant.iconUrl} alt="" width={44} height={44} className="size-11 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted font-semibold text-muted-foreground">
                          {Array.from(assistant.name.trim())[0]?.toUpperCase() ?? 'A'}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <Link href={detailHref} className="line-clamp-1 font-semibold text-foreground hover:underline">{assistant.name}</Link>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{assistant.namespace}</p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-10 flex-1 text-sm leading-5 text-muted-foreground">
                      {assistant.summary ?? t('noDescription')}
                    </p>
                    <div className="mt-3 flex min-h-7 flex-wrap gap-1.5">
                      {assistant.categories.slice(0, 3).map((item) => (
                        <Link
                          key={item.slug}
                          href={marketHref(slug, { q, sort, category: item.slug })}
                          className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {item.name}
                        </Link>
                      ))}
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t('versionLabel', { version: assistant.latestRelease.version })}</span>
                      <span className="inline-flex items-center gap-1"><Copy className="size-3.5" />{assistant.installCount}</span>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4">
                      <Link href={detailHref} className="ui-button-secondary h-9 min-w-0 px-3">{t('viewDetails')}<ArrowRight className="size-4" /></Link>
                      <Link href={createHref} className="ui-button-primary h-9 min-w-0 px-3"><Plus className="size-4" />{t('createFromTemplate')}</Link>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <DashboardPagination
            page={result.page}
            lastPage={lastPage}
            summary={t('paginationSummary', { page: result.page, lastPage, total: result.total, label: t('assistantResources') })}
            previousLabel={common('previous')}
            nextLabel={common('next')}
            hrefForPage={(nextPage) => marketHref(slug, { q, category, sort, page: nextPage })}
          />
        </div>
      </div>
    </DashboardPage>
  );
}
