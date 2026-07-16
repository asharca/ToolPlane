import { GitBranch, Plus, Wrench } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AdminBadge,
  AdminEmptyState,
  AdminEntity,
  AdminPage,
  AdminPageHeader,
  AdminPagination,
  AdminSearchForm,
  AdminTableLink,
} from '@/components/admin/AdminUI';
import { SkillRegistrySync } from '@/components/admin/SkillRegistrySync';
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import { listDirectorySkills } from '@/lib/admin/market';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { requireAdmin } from '@/lib/auth/admin';
import { defaultTpSkillsSource } from '@/lib/skills/registry';

export const dynamic = 'force-dynamic';

export default async function AdminSkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const [t, params] = await Promise.all([
    getTranslations('admin'),
    searchParams,
    requireAdmin(),
  ]);
  const { page = '1' } = params;
  const rawQuery = params.q ?? '';
  const q = rawQuery.trim();
  const rawPage = Number(page);
  const requestedPage = normalizeAdminPage(rawPage);
  const {
    items,
    total,
    page: currentPage,
    pageSize,
  } = await listDirectorySkills({ page: requestedPage, q });
  const tpSkillsSource = defaultTpSkillsSource();

  const hrefForPage = (targetPage: number) => {
    const query = new URLSearchParams({ page: String(targetPage) });
    if (q) query.set('q', q);
    return `/admin/skills?${query.toString()}`;
  };
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (rawQuery !== q || rawPage !== requestedPage || currentPage > lastPage) {
    redirect(hrefForPage(Math.min(currentPage, lastPage)));
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title={t('directorySkills')}
        description={t('skillsDescription')}
        meta={t('skillCount', { count: total.toLocaleString() })}
        actions={
          <>
            <Link href="/admin/skills/import" className="ui-button-secondary">
              <GitBranch className="size-4" aria-hidden="true" />
              {t('importFromGithub')}
            </Link>
            <Link href="/admin/skills/new" className="ui-button-primary">
              <Plus className="size-4" aria-hidden="true" />
              {t('addSkill')}
            </Link>
          </>
        }
      />

      <SkillRegistrySync source={tpSkillsSource} />

      <AdminSearchForm
        defaultValue={q}
        placeholder={t('searchNameOrSlug')}
        label={t('searchNameOrSlug')}
        searchLabel={t('search')}
        clearLabel={t('clear')}
        clearHref="/admin/skills"
      />

      {items.length === 0 ? (
        <AdminEmptyState
          icon={Wrench}
          title={t('noSkills')}
          description={q ? t('noSkillsDescription') : t('emptySkillsDescription')}
          actions={q ? null : (
            <Link href="/admin/skills/new" className="ui-button-primary">
              <Plus className="size-4" aria-hidden="true" />
              {t('addSkill')}
            </Link>
          )}
        />
      ) : (
        <DashboardTable
          ariaLabel={t('skillsTableLabel')}
          minWidth="64rem"
          headers={[
            { label: t('skillColumn'), className: 'w-full' },
            { label: t('scoreColumn'), align: 'right' },
            { label: t('installsColumn'), align: 'right' },
            { label: t('bundleColumn'), align: 'right' },
            { label: t('statusColumn') },
            { label: <span className="sr-only">{t('edit')}</span> },
          ]}
        >
          {items.map((skill) => {
            const bundleSize = Array.isArray(skill.files) ? skill.files.length + 1 : 1;

            return (
              <tr key={skill.id}>
                <td className="px-4 py-3">
                  <AdminEntity
                    title={
                      <Link
                        href={`/admin/skills/${skill.id}/edit`}
                        className="hover:underline"
                      >
                        {skill.name}
                      </Link>
                    }
                    description={`/${skill.slug}`}
                    initials={skill.name}
                  />
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {skill.score}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {skill._count.installs}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {bundleSize}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {skill.curated ? (
                    <AdminBadge tone="brand">{t('curated')}</AdminBadge>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t('none')}</span>
                  )}
                </td>
                <td className="px-2 py-3">
                  <AdminTableLink
                    href={`/admin/skills/${skill.id}/edit`}
                    label={`${t('edit')}: ${skill.name}`}
                  />
                </td>
              </tr>
            );
          })}
        </DashboardTable>
      )}

      <AdminPagination
        page={currentPage}
        total={total}
        pageSize={pageSize}
        itemLabel={t('directorySkills')}
        pageLabel={t('page')}
        previousLabel={t('prev')}
        nextLabel={t('next')}
        hrefForPage={hrefForPage}
      />
    </AdminPage>
  );
}
