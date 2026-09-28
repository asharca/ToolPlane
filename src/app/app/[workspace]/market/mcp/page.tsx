
import { AnimatedBadge } from '@/components/motion/animated-badge';

import { Button, ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { FormSelect } from '@/components/ui/FormSelect';
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
  SlidersHorizontal,
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
import { installMarketResourceAction } from '@/lib/market/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { MarketCategorySidebar } from '@/components/dashboard/market/MarketCategorySidebar';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSection,
} from '@/components/dashboard/DashboardUI';

export const dynamic = 'force-dynamic';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

type MarketSort = 'popular' | 'newest' | 'name';
type McpMarketType = BrowseServer['mcpKind'];

function marketHref(
  workspace: string,
  input: { q?: string; page?: number; category?: string; sort?: MarketSort; type?: McpMarketType },
) {
  const query = new URLSearchParams();
  if (input.q) query.set('q', input.q);
  if (input.category) query.set('category', input.category);
  if (input.sort && input.sort !== 'popular') query.set('sort', input.sort);
  if (input.page && input.page > 1) query.set('page', String(input.page));
  if (input.type === 'connector') query.set('type', input.type);
  const suffix = query.toString();
  const base = `/app/${encodeURIComponent(workspace)}/market/mcp`;
  return suffix ? `${base}?${suffix}` : base;
}

function McpIcon({
  iconUrl,
  name,
}: {
  iconUrl: string | null;
  name: string;
}) {
  return iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={iconUrl} alt="" width={40} height={40} className="size-10 shrink-0 rounded-lg object-cover" />
  ) : (
    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground">
      {Array.from(name.trim())[0]?.toUpperCase() ?? 'M'}
    </span>
  );
}

function McpMarketplaceAction({
  workspace,
  server,
  deploymentId,
  t,
}: {
  workspace: string;
  server: BrowseServer;
  deploymentId: string | null;
  t: Translate;
}) {
  if (server.mcpKind === 'server') return null;

  if (deploymentId) {
    return (
      <ButtonLink
        href={`/app/${encodeURIComponent(workspace)}/mcp/${encodeURIComponent(deploymentId)}`}
        variant="primary" size="sm" className="w-full min-w-0"
      >
        <CheckCircle2 className="size-3.5" />
        {t('manageDeployment')}
      </ButtonLink>
    );
  }

  return (
    <form action={server.marketListing ? installMarketResourceAction : deployServerAction} className="w-full min-w-0">
      <input type="hidden" name="workspace" value={workspace} />
      {server.marketListing ? (
        <input type="hidden" name="releaseId" value={server.marketListing.releaseId} />
      ) : (
        <input type="hidden" name="serverId" value={server.id} />
      )}
      <SubmitButton
        flash={false}
        pendingLabel={t(server.mcpKind === 'connector' ? 'connecting' : 'adding')}
        variant="primary" size="sm" className="w-full min-w-0"
      >
        <ArrowRight className="size-3.5" />
        {t(server.mcpKind === 'connector' ? 'connectToWorkspace' : 'addToWorkspace')}
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
  const detailHref = server.marketListing
    ? `/app/${encodeURIComponent(workspace)}/market/items/${encodeURIComponent(server.marketListing.namespace)}/${encodeURIComponent(server.marketListing.slug)}`
    : `/app/${encodeURIComponent(workspace)}/market/mcp/${encodeURIComponent(server.slug)}`;

  return (
    <article className="rounded-3xl border border-border bg-card flex min-w-0 flex-col p-4">
      <div className="flex min-w-0 items-start gap-3">
        <McpIcon iconUrl={server.iconUrl} name={server.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={detailHref} className="min-w-0 truncate text-base font-semibold text-foreground hover:underline">
              {server.name}
            </Link>
            <AnimatedBadge status="neutral" size="sm">
              {t(server.mcpKind === 'connector' ? 'connectorBadge' : 'serverBadge')}
            </AnimatedBadge>
            {server.isOfficial ? (
              <AnimatedBadge status="success" size="sm">
                <BadgeCheck className="size-3" aria-hidden="true" />
                {t('official')}
              </AnimatedBadge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{server.author ?? t('unknownPublisher')}</p>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
        {server.description ?? t('noDescription')}
      </p>

      {server.categories.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {server.categories.slice(0, 3).map((category) => (
            <ButtonLink
              key={category.slug}
              href={marketHref(workspace, { category: category.slug, type: server.mcpKind })}
              variant="ghost" size="sm"
            >
              {category.name}
            </ButtonLink>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t('verifiedRecipe')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Star className="size-3.5" aria-hidden="true" />
          {server.stars.toLocaleString(locale)}
        </span>
        {server.mcpKind === 'connector' && deploymentId ? (
          <span className="inline-flex items-center gap-1 text-(--color-success) dark:text-(--color-success)">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            {t('addedToWorkspace')}
          </span>
        ) : null}
      </div>

      <div className={`mt-4 grid gap-2 border-t border-border pt-4 ${server.mcpKind === 'connector' ? 'grid-cols-2' : ''}`}>
        <ButtonLink href={detailHref} variant="secondary" size="sm" className="min-w-0">
          {t('viewDetails')}
          <ChevronRight className="size-3.5" />
        </ButtonLink>
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
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
    category?: string | string[];
    sort?: string | string[];
    type?: string | string[];
  }>;
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
  const category = firstParam(query.category).trim();
  const type: McpMarketType = firstParam(query.type) === 'connector' ? 'connector' : 'server';
  const requestedSort = firstParam(query.sort);
  const sort: MarketSort = requestedSort === 'newest' || requestedSort === 'name'
    ? requestedSort
    : 'popular';
  const [{ featured, all, total, availableTotal, pageSize, categories }, deployments] = await Promise.all([
    getBrowseServers(page, q, { category, sort, type }),
    getDeployments(workspace.id),
  ]);
  const deploymentByServerId = new Map(
    deployments.flatMap((deployment) => deployment.serverId
      ? [[deployment.serverId, deployment.id] as const]
      : []),
  );
  const pageFeatured = page === 1 ? featured : [];
  const featuredIds = new Set(pageFeatured.map((server) => server.id));
  const remainingServers = all.filter((server) => !featuredIds.has(server.id));
  const featuredServers = remainingServers.length > 0 ? pageFeatured : [];
  const allServers = featuredServers.length > 0 ? remainingServers : all;
  const deployedCatalogCount = deploymentByServerId.size;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (category && !categories.some((item) => item.slug === category)) {
    redirect(marketHref(slug, { q, sort, type }));
  }
  if (page > lastPage) redirect(marketHref(slug, { q, category, sort, type, page: lastPage }));
  const hasFilters = Boolean(q || category || sort !== 'popular');

  return (
    <DashboardPage className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-foreground">{t('mcpTitle')}</h2>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {t(type === 'connector' ? 'mcpConnectorsDescription' : 'mcpServersDescription')}
        </p>
      </div>

      <nav aria-label={t('mcpTypeNavigation')} className="flex flex-wrap gap-2">
        {(['server', 'connector'] as const).map((item) => (
          <ButtonLink key={item} href={marketHref(slug, { q, sort, type: item })} variant={type === item ? 'primary' : 'secondary'} size="sm" aria-current={type === item ? 'page' : undefined}>
            {t(item === 'connector' ? 'mcpConnectors' : 'mcpServers')}
          </ButtonLink>
        ))}
      </nav>

      <form className="flex w-full flex-col gap-2 sm:flex-row">
        <input type="hidden" name="category" value={category} />
        {type === 'connector' ? <input type="hidden" name="type" value="connector" /> : null}
        <div className="relative min-w-0 flex-1">
          
          
          <Input label={t('searchMcp')} leftIcon={<Search />} name="q" defaultValue={q} placeholder={t('searchMcp')} className="w-full" />
        </div>
        <FormSelect name="sort" defaultValue={sort} label={t('sortResources')} options={[{ value: "popular", label: t('sortPopular') }, { value: "newest", label: t('sortNewest') }, { value: "name", label: t('sortName') }]} className="sm:w-40" />
        <Button variant="secondary" size="md" type="submit"><SlidersHorizontal className="size-4" />{t('applyFilters')}</Button>
      </form>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <MarketCategorySidebar
          label={t('filterByCategory')}
          allLabel={t('allCategories')}
          allHref={marketHref(slug, { q, sort, type })}
          allCount={availableTotal}
          allActive={!category}
          categories={categories.map((item) => ({
            name: item.name,
            count: item.count,
            active: item.slug === category,
            href: marketHref(slug, { q, sort, type, category: item.slug === category ? undefined : item.slug }),
          }))}
        />

        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted-foreground">{t('mcpResultSummary', { count: total })}</p>
            <div className="flex flex-wrap items-center gap-3">
              {hasFilters ? (
                <ButtonLink href={marketHref(slug, { type })} variant="ghost" size="sm">{t('clearFilters')}</ButtonLink>
              ) : null}
              {deployedCatalogCount > 0 ? (
                <ButtonLink href={`/app/${encodeURIComponent(slug)}/mcp`} variant="ghost" size="sm">
                  <CheckCircle2 className="size-4 text-(--color-success) dark:text-(--color-success)" aria-hidden="true" />
                  {t('workspaceDeploymentSummary', { count: deployedCatalogCount })}
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </ButtonLink>
              ) : null}
            </div>
          </div>

          {featuredServers.length > 0 ? (
            <DashboardSection title={t('featuredMcp')}>
              <div className="grid gap-3 md:grid-cols-2">
                {featuredServers.map((server) => (
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

          <DashboardSection
            title={q ? t('searchResults', { query: q }) : t(type === 'connector' ? 'allMcpConnectors' : 'allMcpServers')}
            count={total}
          >
            {allServers.length === 0 ? (
              <DashboardEmptyState
                title={t('noMcpTitle')}
                description={q ? t('noSearchResults', { query: q }) : t('noMcpDescription')}
                actions={hasFilters ? <ButtonLink href={marketHref(slug, { type })} variant="secondary" size="md">{t('clearFilters')}</ButtonLink> : undefined}
              />
            ) : (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  {allServers.map((server) => (
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
                <DashboardPagination
                  page={page}
                  lastPage={lastPage}
                  summary={t('paginationSummary', { page, lastPage, total, label: t('mcpResources') })}
                  previousLabel={common('previous')}
                  nextLabel={common('next')}
                  hrefForPage={(nextPage) => marketHref(slug, { q, category, sort, type, page: nextPage })}
                />
              </>
            )}
          </DashboardSection>
        </div>
      </div>
    </DashboardPage>
  );
}
