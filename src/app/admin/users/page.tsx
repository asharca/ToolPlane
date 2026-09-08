import { Users } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
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
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import { listUsers } from '@/lib/admin/users';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { adminHref } from '@/lib/admin/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; role?: string; status?: string }>;
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
  const ops = await getTranslations('adminOps');
  const role = ['admin', 'user'].includes(params.role ?? '') ? params.role! : '';
  const status = ['active', 'suspended'].includes(params.status ?? '') ? params.status! : '';
  const rawPage = Number(page);
  const requestedPage = normalizeAdminPage(rawPage);
  const timeZone = resolveUserTimeZone(admin);
  const {
    items,
    total,
    page: currentPage,
    pageSize,
  } = await listUsers({ page: requestedPage, q, role, status });

  const hrefForPage = (targetPage: number) => {
    const query = new URLSearchParams({ page: String(targetPage) });
    if (q) query.set('q', q);
    if (role) query.set('role', role);
    if (status) query.set('status', status);
    return `/admin/users?${query.toString()}`;
  };
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (rawQuery !== q || rawPage !== requestedPage || currentPage > lastPage) {
    redirect(hrefForPage(Math.min(currentPage, lastPage)));
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title={t('users')}
        description={t('usersDescription')}
        meta={t('accountCount', { count: total.toLocaleString() })}
      />

      <AdminSearchForm
        defaultValue={q}
        placeholder={t('searchEmailOrName')}
        label={t('searchEmailOrName')}
        searchLabel={t('search')}
        clearLabel={t('clear')}
        clearHref="/admin/users"
      >
        <select name="role" aria-label={t('roleColumn')} defaultValue={role} className="ui-input h-11 w-auto sm:h-9">
          <option value="">{ops('allRoles')}</option><option value="user">{t('user')}</option><option value="admin">{t('administrator')}</option>
        </select>
        <select name="status" aria-label={t('statusColumn')} defaultValue={status} className="ui-input h-11 w-auto sm:h-9">
          <option value="">{ops('allStatuses')}</option><option value="active">{t('active')}</option><option value="suspended">{t('suspended')}</option>
        </select>
      </AdminSearchForm>

      {items.length === 0 ? (
        <AdminEmptyState
          icon={Users}
          title={t('noUsers')}
          description={q ? t('noUsersDescription') : t('emptyUsersDescription')}
        />
      ) : (
        <DashboardTable
          ariaLabel={t('usersTableLabel')}
          minWidth="69rem"
          headers={[
            { label: t('userColumn'), className: 'w-full' },
            { label: t('roleColumn') },
            { label: t('ownedWorkspacesColumn'), align: 'right' },
            { label: t('membershipsColumn'), align: 'right' },
            { label: t('tokensColumn'), align: 'right' },
            { label: t('statusColumn') },
            { label: t('joinedColumn') },
            { label: <span className="sr-only">{t('viewDetails')}</span> },
          ]}
        >
          {items.map((user) => (
            <tr key={user.id}>
              <td className="px-4 py-3">
                <AdminEntity
                  title={
                    <Link
                      href={adminHref(`/admin/users/${user.id}`, { returnTo: hrefForPage(currentPage) })}
                      className="hover:underline"
                    >
                      {user.name ?? user.email}
                    </Link>
                  }
                  description={user.name ? user.email : undefined}
                  initials={user.name ?? user.email}
                />
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <AdminBadge tone={user.role === 'admin' ? 'brand' : 'neutral'}>
                  {user.role === 'admin' ? t('administrator') : t('user')}
                </AdminBadge>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {user._count.ownedWorkspaces}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {user._count.memberships}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {user._count.apiTokens}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <AdminBadge
                  tone={user.status === 'active' ? 'success' : 'warning'}
                  dot
                >
                  {user.status === 'active' ? t('active') : t('suspended')}
                </AdminBadge>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-sm text-muted-foreground">
                {formatInTimeZone(user.createdAt, timeZone, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                }, locale)}
              </td>
              <td className="px-2 py-3">
                <AdminTableLink
                  href={adminHref(`/admin/users/${user.id}`, { returnTo: hrefForPage(currentPage) })}
                  label={`${t('viewDetails')}: ${user.name ?? user.email}`}
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
        itemLabel={t('users')}
        pageLabel={t('page')}
        previousLabel={t('prev')}
        nextLabel={t('next')}
        hrefForPage={hrefForPage}
      />
    </AdminPage>
  );
}
