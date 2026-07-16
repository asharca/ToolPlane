import { Building2 } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AdminEmptyState,
  AdminEntity,
  AdminPage,
  AdminPageHeader,
  AdminPagination,
  AdminSearchForm,
  AdminTableLink,
} from '@/components/admin/AdminUI';
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import { listWorkspaces } from '@/lib/admin/workspaces';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { requireAdmin } from '@/lib/auth/admin';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const [t, locale, admin, params] = await Promise.all([
    getTranslations('admin'),
    getLocale(),
    requireAdmin(),
    searchParams,
  ]);
  const { page = '1' } = params;
  const rawQuery = params.q ?? '';
  const q = rawQuery.trim();
  const rawPage = Number(page);
  const requestedPage = normalizeAdminPage(rawPage);
  const timeZone = resolveUserTimeZone(admin);
  const {
    items,
    total,
    page: currentPage,
    pageSize,
  } = await listWorkspaces({ page: requestedPage, q });

  const hrefForPage = (targetPage: number) => {
    const query = new URLSearchParams({ page: String(targetPage) });
    if (q) query.set('q', q);
    return `/admin/workspaces?${query.toString()}`;
  };
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (rawQuery !== q || rawPage !== requestedPage || currentPage > lastPage) {
    redirect(hrefForPage(Math.min(currentPage, lastPage)));
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title={t('workspaces')}
        description={t('workspacesDescription')}
        meta={t('workspaceCount', { count: total.toLocaleString() })}
      />

      <AdminSearchForm
        defaultValue={q}
        placeholder={t('searchNameOrSlug')}
        label={t('searchNameOrSlug')}
        searchLabel={t('search')}
        clearLabel={t('clear')}
        clearHref="/admin/workspaces"
      />

      {items.length === 0 ? (
        <AdminEmptyState
          icon={Building2}
          title={t('noWorkspaces')}
          description={q ? t('noWorkspacesDescription') : t('emptyWorkspacesDescription')}
        />
      ) : (
        <DashboardTable
          ariaLabel={t('workspacesTableLabel')}
          minWidth="70rem"
          headers={[
            { label: t('workspaceColumn'), className: 'w-full' },
            { label: t('ownerColumn') },
            { label: t('membersColumn'), align: 'right' },
            { label: t('agentsColumn'), align: 'right' },
            { label: t('deploymentsColumn'), align: 'right' },
            { label: t('createdColumn') },
            { label: <span className="sr-only">{t('viewDetails')}</span> },
          ]}
        >
          {items.map((workspace) => (
            <tr key={workspace.id}>
              <td className="px-4 py-3">
                <AdminEntity
                  title={
                    <Link
                      href={`/admin/workspaces/${workspace.id}`}
                      className="hover:underline"
                    >
                      {workspace.name}
                    </Link>
                  }
                  description={`/${workspace.slug}`}
                  initials={workspace.name}
                />
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <Link
                  href={`/admin/users/${workspace.owner.id}`}
                  className="text-sm font-medium text-foreground hover:underline"
                >
                  {workspace.owner.email}
                </Link>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {workspace._count.members}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {workspace._count.agents}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {workspace._count.deployments}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-sm text-muted-foreground">
                {formatInTimeZone(workspace.createdAt, timeZone, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                }, locale)}
              </td>
              <td className="px-2 py-3">
                <AdminTableLink
                  href={`/admin/workspaces/${workspace.id}`}
                  label={`${t('viewDetails')}: ${workspace.name}`}
                />
              </td>
            </tr>
          ))}
        </DashboardTable>
      )}

      <AdminPagination
        page={currentPage}
        total={total}
        pageSize={pageSize}
        itemLabel={t('workspaces')}
        pageLabel={t('page')}
        previousLabel={t('prev')}
        nextLabel={t('next')}
        hrefForPage={hrefForPage}
      />
    </AdminPage>
  );
}
