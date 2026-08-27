import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Search, SlidersHorizontal } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getBrowseSkills,
  getSkillBrowseCategories,
  getWorkspaceForUser,
  type SkillBrowseFilters,
} from '@/lib/workspace/queries';
import { BrowseGrid } from '@/components/dashboard/BrowseGrid';
import { installSkillAction } from '@/lib/workspace/actions';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPagination,
  DashboardSection,
} from '@/components/dashboard/DashboardUI';
import { NativeSelect } from '@/components/ui/NativeSelect';

export const dynamic = 'force-dynamic';

type SearchParams = {
  page?: string | string[];
  q?: string | string[];
  source?: string | string[];
  installation?: string | string[];
  category?: string | string[];
  sort?: string | string[];
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function skillMarketHref(
  workspace: string,
  input: {
    q?: string;
    page?: number;
    source?: SkillBrowseFilters['source'];
    installation?: SkillBrowseFilters['installation'];
    category?: string;
    sort?: SkillBrowseFilters['sort'];
  },
) {
  const query = new URLSearchParams();
  if (input.q) query.set('q', input.q);
  if (input.source && input.source !== 'all') query.set('source', input.source);
  if (input.installation && input.installation !== 'all') query.set('installation', input.installation);
  if (input.category && input.category !== 'all') query.set('category', input.category);
  if (input.sort && input.sort !== 'top') query.set('sort', input.sort);
  if (input.page && input.page > 1) query.set('page', String(input.page));
  const suffix = query.toString();
  const base = `/app/${encodeURIComponent(workspace)}/market/skills`;
  return suffix ? `${base}?${suffix}` : base;
}

export default async function SkillMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ workspace: slug }, query, t, common] = await Promise.all([
    params,
    searchParams,
    getTranslations('console.market'),
    getTranslations('common'),
  ]);
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/app/login?next=${encodeURIComponent(`/app/${slug}/market/skills`)}`);
  }
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');

  const rawPage = Number(firstParam(query.page));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const q = firstParam(query.q).trim();
  const source: SkillBrowseFilters['source'] = ['github', 'other'].includes(firstParam(query.source))
    ? firstParam(query.source) as SkillBrowseFilters['source']
    : 'all';
  const installation: SkillBrowseFilters['installation'] = ['available', 'installed'].includes(firstParam(query.installation))
    ? firstParam(query.installation) as SkillBrowseFilters['installation']
    : 'all';
  const requestedCategory = firstParam(query.category) || 'all';
  const sort: SkillBrowseFilters['sort'] = ['newest', 'name'].includes(firstParam(query.sort))
    ? firstParam(query.sort) as SkillBrowseFilters['sort']
    : 'top';

  const categories = await getSkillBrowseCategories();
  const category = requestedCategory === 'all'
    || requestedCategory === 'uncategorized'
    || categories.some((item) => item.slug === requestedCategory)
    ? requestedCategory
    : 'all';
  const browse = await getBrowseSkills(page, q, {
    workspaceId: workspace.id,
    source,
    installation,
    category,
    sort,
  });
  const { featured, all, total, pageSize } = browse;
  const pageFeatured = page === 1 ? featured : [];
  const featuredIds = new Set(pageFeatured.map((skill) => skill.id));
  const remainingSkills = all.filter((skill) => !featuredIds.has(skill.id));
  const featuredSkills = remainingSkills.length > 0 ? pageFeatured : [];
  const allSkills = featuredSkills.length > 0 ? remainingSkills : all;
  const installedIds = new Set(
    [...featuredSkills, ...allSkills].filter((skill) => skill.installed).map((skill) => skill.id),
  );
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (page > lastPage) {
    redirect(skillMarketHref(slug, { q, source, installation, category, sort, page: lastPage }));
  }
  const hasFilters = Boolean(
    q || source !== 'all' || installation !== 'all' || category !== 'all' || sort !== 'top',
  );

  return (
    <DashboardPage className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{t('skillsTitle')}</h2>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('skillsDescription')}</p>
      </div>

      <form className="grid w-full grid-cols-1 items-center gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1fr)_7.5rem_10rem_10rem_8.5rem_auto]">
        <label className="relative min-w-0 sm:col-span-2 xl:col-span-1">
          <span className="sr-only">{t('searchSkills')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input name="q" defaultValue={q} placeholder={t('searchSkills')} className="ui-input ui-input-icon h-10 w-full" />
        </label>
        <NativeSelect name="source" defaultValue={source} aria-label={t('filterBySource')} className="ui-input h-10">
          <option value="all">{t('allSources')}</option>
          <option value="github">{t('github')}</option>
          <option value="other">{t('otherSources')}</option>
        </NativeSelect>
        <NativeSelect name="installation" defaultValue={installation} aria-label={t('filterByInstallation')} className="ui-input h-10">
          <option value="all">{t('allInstallations')}</option>
          <option value="available">{t('available')}</option>
          <option value="installed">{t('installed')}</option>
        </NativeSelect>
        <NativeSelect name="category" defaultValue={category} aria-label={t('filterByCategory')} className="ui-input h-10">
          <option value="all">{t('allCategories')}</option>
          <option value="uncategorized">{t('uncategorized')}</option>
          {categories.map((item) => (
            <option key={item.slug} value={item.slug}>{item.name} ({item._count.skills})</option>
          ))}
        </NativeSelect>
        <NativeSelect name="sort" defaultValue={sort} aria-label={t('sortSkills')} className="ui-input h-10">
          <option value="top">{t('sortTop')}</option>
          <option value="newest">{t('sortNewest')}</option>
          <option value="name">{t('sortName')}</option>
        </NativeSelect>
        <button className="ui-button-secondary h-10"><SlidersHorizontal className="size-4" />{t('applyFilters')}</button>
      </form>

      {featuredSkills.length > 0 ? (
        <DashboardSection title={t('featuredSkills')}>
          <BrowseGrid
            items={featuredSkills}
            installedIds={installedIds}
            slug={slug}
            action={installSkillAction}
            idField="skillId"
            actionLabel={t('install')}
            pendingLabel={t('installing')}
            installedLabel={t('installed')}
            detailKind="skills"
          />
        </DashboardSection>
      ) : null}

      <DashboardSection
        title={hasFilters ? t('filteredSkills') : t('allSkills')}
        count={total}
        actions={hasFilters ? (
          <Link href={skillMarketHref(slug, {})} className="text-xs font-medium text-foreground hover:underline">
            {t('clearFilters')}
          </Link>
        ) : undefined}
      >
        {allSkills.length === 0 ? (
          <DashboardEmptyState
            title={t('noSkillsTitle')}
            description={hasFilters ? t('noSkillsMatchFilters') : t('noSkillsDescription')}
            actions={hasFilters ? <Link href={skillMarketHref(slug, {})} className="ui-button-secondary">{t('clearFilters')}</Link> : undefined}
          />
        ) : (
          <>
            <BrowseGrid
              items={allSkills}
              installedIds={installedIds}
              slug={slug}
              action={installSkillAction}
              idField="skillId"
              actionLabel={t('install')}
              pendingLabel={t('installing')}
              installedLabel={t('installed')}
              detailKind="skills"
            />
            <DashboardPagination
              page={page}
              lastPage={lastPage}
              summary={t('paginationSummary', { page, lastPage, total, label: t('skillResources') })}
              previousLabel={common('previous')}
              nextLabel={common('next')}
              hrefForPage={(nextPage) => skillMarketHref(slug, { q, source, installation, category, sort, page: nextPage })}
            />
          </>
        )}
      </DashboardSection>
    </DashboardPage>
  );
}
