import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Brain, CopyPlus, Plug, Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getBrowseToolkits } from '@/lib/toolkits/queries';
import { clonePublicToolkitAction } from '@/lib/toolkits/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSearchForm,
  DashboardSection,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
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

export default async function ToolkitMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string | string[]; q?: string | string[] }>;
}) {
  const [{ workspace: slug }, { page: pageParam, q: qParam }, t, common, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.toolkits'),
    getTranslations('common'),
    getLocale(),
  ]);
  const rawPage = Number(firstParam(pageParam));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const q = firstParam(qParam).trim().slice(0, 160);
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const marketHref = `/app/${encodeURIComponent(slug)}/market/toolkits`;
  const { items, total, pageSize } = await getBrowseToolkits(ws.id, page, q);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (page > lastPage) {
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (lastPage > 1) query.set('page', String(lastPage));
    redirect(`${marketHref}${query.size > 0 ? `?${query.toString()}` : ''}`);
  }

  return (
    <DashboardPage className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{t('publicToolkits')}</h2>
        <div>
          <Link href={`/app/${encodeURIComponent(slug)}/toolkits`} className="ui-button-ghost">
            {t('backToToolkits')}
          </Link>
        </div>
      </div>

      <DashboardToolbar className="rounded-lg border border-border bg-card p-3">
        <DashboardSearchForm
          defaultValue={q}
          placeholder={t('searchPublicToolkits')}
          clearHref={marketHref}
          width="sm:w-[28rem]"
          submitLabel={common('search')}
          clearLabel={t('clearSearch')}
        />
      </DashboardToolbar>

      <DashboardSection
        title={q ? t('searchResults', { query: q }) : t('title')}
        count={total}
      >
        {items.length === 0 ? (
          <DashboardEmptyState
            icon={Wrench}
            description={q ? t('noPublicToolkitsMatch', { query: q }) : t('noPublicToolkitsYet')}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((toolkit) => (
              <article key={toolkit.id} className="ui-panel flex min-w-0 flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{toolkit.workspaceName}</span>
                      <span aria-hidden="true">/</span>
                      <time dateTime={toolkit.createdAt.toISOString()}>
                        {fmt(toolkit.createdAt, timeZone, locale)}
                      </time>
                    </div>
                    <h3 className="truncate font-semibold text-foreground">
                      {toolkit.name}
                    </h3>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                    <Wrench className="size-3.5" />
                    {toolkit.toolCount}
                  </span>
                </div>

                <div className="mt-4 grid flex-1 grid-cols-2 divide-x divide-border border-y border-border py-3">
                  <div className="min-w-0 pr-3">
                    <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                      <Plug className="size-3.5" />
                      {t('mcp')} {toolkit.serverCount}
                    </div>
                    <p className="truncate text-sm text-foreground">
                      {preview(toolkit.serverNames, t('noMcp'))}
                    </p>
                  </div>
                  <div className="min-w-0 pl-3">
                    <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
                      <Brain className="size-3.5" />
                      {t('skills')} {toolkit.skillCount}
                    </div>
                    <p className="truncate text-sm text-foreground">
                      {preview(toolkit.skillNames, t('noSkills'))}
                    </p>
                  </div>
                </div>

                {toolkit.customServerCount > 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t('customSetupSummary', { count: toolkit.customServerCount })}
                  </p>
                ) : null}

                <form action={clonePublicToolkitAction} className="mt-4 border-t border-border pt-4">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="toolkitId" value={toolkit.id} />
                  <SubmitButton
                    className="ui-button-primary h-9 w-full"
                    pendingLabel={t('importing')}
                    flash={false}
                  >
                    <CopyPlus className="size-4" />
                    {t('import')}
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
        hrefForPage={(nextPage) => `${marketHref}?${q ? `q=${encodeURIComponent(q)}&` : ''}page=${nextPage}`}
      />
    </DashboardPage>
  );
}
