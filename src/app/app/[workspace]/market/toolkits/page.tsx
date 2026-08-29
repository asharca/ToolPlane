import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Brain, CopyPlus, Plug, Search, SlidersHorizontal, Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getBrowseToolkits, type ToolkitBrowseFilters } from '@/lib/toolkits/queries';
import { clonePublicToolkitAction } from '@/lib/toolkits/actions';
import { installMarketResourceAction } from '@/lib/market/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSection,
} from '@/components/dashboard/DashboardUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { MarketCategorySidebar } from '@/components/dashboard/market/MarketCategorySidebar';
import { NativeSelect } from '@/components/ui/NativeSelect';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

function fmt(d: Date, timeZone: string, locale: string) {
  return formatInTimeZone(d, timeZone, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }, locale);
}

function preview(names: string[], fallback: string) {
  if (names.length === 0) return <span className="text-muted-foreground">{fallback}</span>;
  return <span className="truncate">{names.join(', ')}</span>;
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function marketHref(
  workspace: string,
  input: { q?: string; category?: string; sort?: ToolkitBrowseFilters['sort']; page?: number },
) {
  const query = new URLSearchParams();
  if (input.q) query.set('q', input.q);
  if (input.category) query.set('category', input.category);
  if (input.sort === 'name') query.set('sort', input.sort);
  if (input.page && input.page > 1) query.set('page', String(input.page));
  const suffix = query.toString();
  const base = `/app/${encodeURIComponent(workspace)}/market/toolkits`;
  return suffix ? `${base}?${suffix}` : base;
}

export default async function ToolkitMarketPage({
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
  const [{ workspace: slug }, query, t, common, marketT, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.toolkits'),
    getTranslations('common'),
    getTranslations('console.market'),
    getLocale(),
  ]);
  const pageParam = firstParam(query.page);
  const qParam = firstParam(query.q);
  const rawPage = Number(firstParam(pageParam));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const q = firstParam(qParam).trim().slice(0, 160);
  const category = firstParam(query.category).trim();
  const sort: ToolkitBrowseFilters['sort'] = firstParam(query.sort) === 'name' ? 'name' : 'newest';
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const result = await getBrowseToolkits(ws.id, page, q, { category, sort });
  const { items, total, availableTotal, categories, pageSize } = result;
  if (category && !categories.some((item) => item.slug === category)) {
    redirect(marketHref(slug, { q, sort }));
  }
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (page > lastPage) {
    redirect(marketHref(slug, { q, category, sort, page: lastPage }));
  }
  const hasFilters = Boolean(q || category || sort !== 'newest');

  return (
    <DashboardPage className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold text-foreground">{t('publicToolkits')}</h2>
        <div>
          <Link href={`/app/${encodeURIComponent(slug)}/toolkits`} className="ui-button-ghost">
            {t('backToToolkits')}
          </Link>
        </div>
      </div>

      <form className="flex w-full flex-col gap-2 sm:flex-row">
        <input type="hidden" name="category" value={category} />
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('searchPublicToolkits')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input name="q" defaultValue={q} placeholder={t('searchPublicToolkits')} className="ui-input ui-input-icon h-10 w-full" />
        </label>
        <NativeSelect name="sort" defaultValue={sort} aria-label={marketT('sortResources')} className="ui-input h-10 sm:w-40">
          <option value="newest">{marketT('sortNewest')}</option>
          <option value="name">{marketT('sortName')}</option>
        </NativeSelect>
        <button className="ui-button-secondary h-10"><SlidersHorizontal className="size-4" />{marketT('applyFilters')}</button>
      </form>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <MarketCategorySidebar
          label={marketT('filterByCategory')}
          allLabel={marketT('allCategories')}
          allHref={marketHref(slug, { q, sort })}
          allCount={availableTotal}
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
            <span>{t('toolkitCount', { count: total })}</span>
            {hasFilters ? (
              <Link href={marketHref(slug, {})} className="font-medium text-foreground hover:underline">{marketT('clearFilters')}</Link>
            ) : null}
          </div>

          <DashboardSection title={q ? t('searchResults', { query: q }) : t('title')} count={total}>
            {items.length === 0 ? (
              <DashboardEmptyState
                icon={Wrench}
                description={q ? t('noPublicToolkitsMatch', { query: q }) : t('noPublicToolkitsYet')}
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {items.map((toolkit) => (
                  <article key={toolkit.id} className="ui-panel flex min-w-0 flex-col p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{toolkit.workspaceName}</span>
                          <span aria-hidden="true">/</span>
                          <time dateTime={toolkit.createdAt.toISOString()}>{fmt(toolkit.createdAt, timeZone, locale)}</time>
                        </div>
                        {toolkit.marketListing ? (
                          <Link
                            href={`/app/${encodeURIComponent(slug)}/market/items/${encodeURIComponent(toolkit.marketListing.namespace)}/${encodeURIComponent(toolkit.marketListing.slug)}`}
                            className="block truncate font-semibold text-foreground hover:underline"
                          >
                            {toolkit.name}
                          </Link>
                        ) : (
                          <h3 className="truncate font-semibold text-foreground">{toolkit.name}</h3>
                        )}
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                        <Wrench className="size-3.5" />{toolkit.toolCount}
                      </span>
                    </div>

                    {toolkit.categories.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {toolkit.categories.slice(0, 3).map((item) => (
                          <Link
                            key={item.slug}
                            href={marketHref(slug, { q, sort, category: item.slug })}
                            className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            {item.name}
                          </Link>
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-4 grid flex-1 grid-cols-2 divide-x divide-border border-y border-border py-3">
                      <div className="min-w-0 pr-3">
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                          <Plug className="size-3.5" />{t('mcp')} {toolkit.serverCount}
                        </div>
                        <p className="truncate text-sm text-foreground">{preview(toolkit.serverNames, t('noMcp'))}</p>
                      </div>
                      <div className="min-w-0 pl-3">
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                          <Brain className="size-3.5" />{t('skills')} {toolkit.skillCount}
                        </div>
                        <p className="truncate text-sm text-foreground">{preview(toolkit.skillNames, t('noSkills'))}</p>
                      </div>
                    </div>

                    {toolkit.customServerCount > 0 ? (
                      <p className="mt-3 text-xs text-muted-foreground">{t('customSetupSummary', { count: toolkit.customServerCount })}</p>
                    ) : null}

                    <form action={toolkit.marketListing ? installMarketResourceAction : clonePublicToolkitAction} className="mt-4 border-t border-border pt-4">
                      <input type="hidden" name="workspace" value={slug} />
                      {toolkit.marketListing ? (
                        <input type="hidden" name="releaseId" value={toolkit.marketListing.releaseId} />
                      ) : (
                        <input type="hidden" name="toolkitId" value={toolkit.id} />
                      )}
                      <SubmitButton className="ui-button-primary h-9 w-full" pendingLabel={t('importing')} flash={false}>
                        <CopyPlus className="size-4" />{t('import')}
                      </SubmitButton>
                    </form>
                  </article>
                ))}
              </div>
            )}
          </DashboardSection>

          <DashboardPagination
            page={page}
            lastPage={lastPage}
            summary={t('paginationSummary', { page, lastPage, total })}
            previousLabel={common('previous')}
            nextLabel={common('next')}
            hrefForPage={(nextPage) => marketHref(slug, { q, category, sort, page: nextPage })}
          />
        </div>
      </div>
    </DashboardPage>
  );
}
