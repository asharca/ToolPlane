import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Search, SlidersHorizontal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getBrowseSkills,
  getSkillBrowseCategories,
  getWorkspaceForUser,
  type SkillBrowseFilters,
} from '@/lib/workspace/queries';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { installSkillAction } from '@/lib/workspace/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSection,
  DashboardTable,
} from '@/components/dashboard/DashboardUI';
import { NativeSelect } from '@/components/ui/NativeSelect';

export const dynamic = 'force-dynamic';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default async function BrowseSkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
    source?: string | string[];
    installation?: string | string[];
    category?: string | string[];
    sort?: string | string[];
  }>;
}) {
  const t = await getTranslations('console.skills');
  const { workspace: slug } = await params;
  const query = await searchParams;
  const page = Math.max(1, Number(firstParam(query.page)) || 1);
  const q = firstParam(query.q).trim();
  const source: SkillBrowseFilters['source'] = ['github', 'other'].includes(firstParam(query.source))
    ? firstParam(query.source) as SkillBrowseFilters['source']
    : 'all';
  const installation: SkillBrowseFilters['installation'] = ['available', 'installed'].includes(
    firstParam(query.installation),
  )
    ? firstParam(query.installation) as SkillBrowseFilters['installation']
    : 'all';
  const requestedCategory = firstParam(query.category) || 'all';
  const sort: SkillBrowseFilters['sort'] = ['newest', 'name'].includes(firstParam(query.sort))
    ? firstParam(query.sort) as SkillBrowseFilters['sort']
    : 'top';
  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const [initialBrowse, categories] = await Promise.all([
    getBrowseSkills(page, q, {
      workspaceId: ws.id,
      source,
      installation,
      category: requestedCategory,
      sort,
    }),
    getSkillBrowseCategories(),
  ]);
  const category =
    requestedCategory === 'all' ||
    requestedCategory === 'uncategorized' ||
    categories.some((item) => item.slug === requestedCategory)
      ? requestedCategory
      : 'all';
  const { featured, all, total, pageSize } =
    category === requestedCategory
      ? initialBrowse
      : await getBrowseSkills(page, q, {
          workspaceId: ws.id,
          source,
          installation,
          category,
          sort,
        });
  const installedIds = new Set(
    [...featured, ...all].filter((skill) => skill.installed).map((skill) => skill.id),
  );
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters = Boolean(
    q || source !== 'all' || installation !== 'all' || category !== 'all' || sort !== 'top',
  );
  const preservedParams = new URLSearchParams();
  if (q) preservedParams.set('q', q);
  if (source !== 'all') preservedParams.set('source', source);
  if (installation !== 'all') preservedParams.set('installation', installation);
  if (category !== 'all') preservedParams.set('category', category);
  if (sort !== 'top') preservedParams.set('sort', sort);
  const hrefForPage = (nextPage: number) => {
    const next = new URLSearchParams(preservedParams);
    next.set('page', String(nextPage));
    return `/app/${slug}/skills/new?${next.toString()}`;
  };

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'Skills', href: `/app/${slug}/skills` }, { label: 'Market' }]}
      />
      <DashboardPage className="space-y-8">
        <div className="space-y-2">
          <form className="grid w-full grid-cols-1 items-center gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1fr)_7.5rem_10rem_10rem_8.5rem_auto]">
            <div className="relative min-w-0 sm:col-span-2 xl:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                name="q"
                defaultValue={q}
                placeholder={t('searchSkills')}
                aria-label={t('searchSkills')}
                className="ui-input ui-input-icon h-9 w-full"
              />
            </div>
            <NativeSelect name="source" defaultValue={source} aria-label={t('filterBySource')} className="ui-input h-9">
              <option value="all">{t('allSources')}</option>
              <option value="github">{t('github')}</option>
              <option value="other">{t('otherSources')}</option>
            </NativeSelect>
            <NativeSelect name="installation" defaultValue={installation} aria-label={t('filterByInstallation')} className="ui-input h-9">
              <option value="all">{t('allInstallations')}</option>
              <option value="available">{t('availableToInstall')}</option>
              <option value="installed">{t('installed')}</option>
            </NativeSelect>
            <NativeSelect name="category" defaultValue={category} aria-label={t('filterByCategory')} className="ui-input h-9">
              <option value="all">{t('allCategories')}</option>
              <option value="uncategorized">{t('uncategorized')}</option>
              {categories.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name} ({item._count.skills})
                </option>
              ))}
            </NativeSelect>
            <NativeSelect name="sort" defaultValue={sort} aria-label={t('sortSkills')} className="ui-input h-9">
              <option value="top">{t('sortTop')}</option>
              <option value="newest">{t('sortNewest')}</option>
              <option value="name">{t('sortName')}</option>
            </NativeSelect>
            <button className="ui-button-secondary h-9 w-full xl:w-auto">
              <SlidersHorizontal className="size-4" />
              {t('applyFilters')}
            </button>
          </form>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasFilters ? (
              <Link href={`/app/${slug}/skills/new`} className="ui-button-ghost">
                {t('clearFilters')}
              </Link>
            ) : null}
            <Link href={`/app/${slug}/skills`} className="ui-button-ghost">
              {t('backToInstalled')}
            </Link>
          </div>
        </div>

        {featured.length > 0 ? (
          <DashboardSection title={t('featuredSkills')}>
            <BrowseGrid
              items={featured}
              installedIds={installedIds}
              slug={slug}
              action={installSkillAction}
              idField="skillId"
              actionLabel="Install"
              installedLabel="Installed"
            />
          </DashboardSection>
        ) : null}

        <DashboardSection title={hasFilters ? t('filteredSkills') : t('allSkills')} count={total}>
          {all.length === 0 ? (
            <DashboardEmptyState
              description={hasFilters ? t('noSkillsMatchFilters') : t('noSkillsFound')}
              actions={hasFilters ? (
                <Link href={`/app/${slug}/skills/new`} className="ui-button-secondary">
                  {t('clearFilters')}
                </Link>
              ) : undefined}
            />
          ) : (
            <>
              <DashboardTable
                headers={[
                  { label: t('skillColumn') },
                  { label: t('source') },
                  { label: t('descriptionColumn') },
                  { align: 'right' },
                ]}
              >
                {all.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {s.iconUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.iconUrl}
                            alt=""
                            width={20}
                            height={20}
                            className="size-5 rounded object-cover"
                          />
                        ) : (
                          <span className="size-5 rounded bg-muted" />
                        )}
                        <Link
                          href={`/tools/skills/${s.slug}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {s.name}
                        </Link>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {s.curated ? (
                            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {t('curated')}
                            </span>
                          ) : null}
                          {s.categories.slice(0, 2).map((item) => (
                            <span key={item.slug} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {item.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {s.githubSource ? t('github') : s.author ?? t('market')}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="line-clamp-1">{s.description}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {installedIds.has(s.id) ? (
                        <span className="text-xs text-muted-foreground">{t('installed')}</span>
                      ) : (
                        <form action={installSkillAction} className="inline">
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="skillId" value={s.id} />
                          <button className="text-xs font-medium text-foreground hover:text-muted-foreground">
                            {t('install')}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </DashboardTable>
              <DashboardPagination
                page={page}
                lastPage={lastPage}
                total={total}
                label={t('skills')}
                hrefForPage={hrefForPage}
              />
            </>
          )}
        </DashboardSection>
      </DashboardPage>
    </>
  );
}
