/* eslint-disable react/jsx-key -- DashboardTable consumes cell arrays as indexed values. */
import { Input } from '@/components/motion/input';
import { FormSelect } from '@/components/ui/FormSelect';
import { Building2 } from 'lucide-react';
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
import { listWorkspaces } from '@/lib/admin/workspaces';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { adminHref } from '@/lib/admin/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; owner?: string; status?: string }>;
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
  const owner = params.owner?.trim() ?? '';
  const status = ['active', 'deleting', 'delete_failed'].includes(params.status ?? '') ? params.status! : '';
  const rawPage = Number(page);
  const requestedPage = normalizeAdminPage(rawPage);
  const timeZone = resolveUserTimeZone(admin);
  const {
    items,
    total,
    page: currentPage,
    pageSize,
  } = await listWorkspaces({ page: requestedPage, q, owner, status });

  const hrefForPage = (targetPage: number) => {
    const query = new URLSearchParams({ page: String(targetPage) });
    if (q) query.set('q', q);
    if (owner) query.set('owner', owner);
    if (status) query.set('status', status);
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
      >
        <Input name="owner" defaultValue={owner} aria-label={ops('ownerFilter')} placeholder={ops('ownerFilter')} maxLength={200} className="w-full sm:w-56" />
        <FormSelect name="status" defaultValue={status} className="w-auto" label={t('statusColumn')} options={[{ value: "", label: ops('allStatuses') }, ...((['active', 'deleting', 'delete_failed'] as const).map((value) => ({ value: value, label: ops(value) })))]} />
      </AdminSearchForm>

      {items.length === 0 ? (
        <AdminEmptyState
          icon={Building2}
          title={t('noWorkspaces')}
          description={q ? t('noWorkspacesDescription') : t('emptyWorkspacesDescription')}
        />
      ) : (
        <DashboardTable ariaLabel={t('workspacesTableLabel')}
minWidth="70rem"
headers={[
            { label: t('workspaceColumn'), width: "35%" },
            { label: t('ownerColumn') },
            { label: t('statusColumn') },
            { label: t('membersColumn'), align: 'right' },
            { label: t('agentsColumn'), align: 'right' },
            { label: t('deploymentsColumn'), align: 'right' },
            { label: t('createdColumn') },
            { label: <span className="sr-only">{t('viewDetails')}</span> },
          ]}
rows={items.map((workspace) => (
            ({ id: workspace.id, cells: [<> <AdminEntity
                  title={
                    <Link
                      href={adminHref(`/admin/workspaces/${workspace.id}`, { returnTo: hrefForPage(currentPage) })}
                      className="hover:underline"
                    >
                      {workspace.name}
                    </Link>
                  }
                  description={`/${workspace.slug}`}
                  initials={workspace.name}
                /> </>,
<Link
                  href={adminHref(`/admin/users/${workspace.owner.id}`, { returnTo: hrefForPage(currentPage) })}
                  className="text-sm font-medium text-foreground hover:underline"
                >
                  {workspace.owner.email}
                </Link>,
<AdminBadge tone={workspace.status === 'active' ? 'success' : workspace.status === 'deleting' ? 'warning' : 'danger'}>{ops.has(workspace.status) ? ops(workspace.status) : workspace.status}</AdminBadge>,
workspace._count.members,
workspace._count.agents,
workspace._count.deployments,
formatInTimeZone(workspace.createdAt, timeZone, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                }, locale),
<> <AdminTableLink
                  href={adminHref(`/admin/workspaces/${workspace.id}`, { returnTo: hrefForPage(currentPage) })}
                  label={`${t('viewDetails')}: ${workspace.name}`}
                /> </>] })
          ))} />
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
