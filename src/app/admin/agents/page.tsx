import { Bot, Plus } from 'lucide-react';
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
  type AdminBadgeTone,
} from '@/components/admin/AdminUI';
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import {
  ADMIN_AGENT_LISTING_STATUSES,
  listDirectoryAgentListings,
  type AdminAgentListingStatus,
} from '@/lib/admin/agent-market';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

function statusTone(status: string): AdminBadgeTone {
  if (status === 'published') return 'success';
  if (status === 'disabled') return 'danger';
  return 'neutral';
}

export default async function AdminAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; status?: string }>;
}) {
  const [t, params] = await Promise.all([
    getTranslations('admin'),
    searchParams,
    requireAdmin(),
  ]);
  const rawQuery = params.q ?? '';
  const q = rawQuery.trim();
  const rawPage = Number(params.page ?? '1');
  const requestedPage = normalizeAdminPage(rawPage);
  const requestedStatus = params.status ?? '';
  const status = ADMIN_AGENT_LISTING_STATUSES.includes(requestedStatus as AdminAgentListingStatus)
    ? requestedStatus as AdminAgentListingStatus
    : undefined;
  const result = await listDirectoryAgentListings({ page: requestedPage, q, status });

  const hrefForPage = (targetPage: number) => {
    const query = new URLSearchParams({ page: String(targetPage) });
    if (q) query.set('q', q);
    if (status) query.set('status', status);
    return `/admin/agents?${query.toString()}`;
  };
  const filterHref = (targetStatus?: AdminAgentListingStatus) => {
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (targetStatus) query.set('status', targetStatus);
    const value = query.toString();
    return value ? `/admin/agents?${value}` : '/admin/agents';
  };
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  if (
    rawQuery !== q
    || rawPage !== requestedPage
    || requestedStatus !== (status ?? '')
    || result.page > lastPage
  ) {
    redirect(hrefForPage(Math.min(result.page, lastPage)));
  }

  const statusLabel = (value: string) => {
    if (value === 'published') return t('agentListingStatusPublished');
    if (value === 'disabled') return t('agentListingStatusDisabled');
    return t('agentListingStatusDraft');
  };

  return (
    <AdminPage>
      <AdminPageHeader
        title={t('directoryAgents')}
        description={t('agentsDirectoryDescription')}
        meta={t('agentListingCount', { count: result.total.toLocaleString() })}
        actions={(
          <Link href="/admin/agents/new" className="ui-button-primary">
            <Plus className="size-4" aria-hidden="true" />
            {t('addAgentTemplate')}
          </Link>
        )}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <AdminSearchForm
          defaultValue={q}
          placeholder={t('searchAgentListings')}
          label={t('searchAgentListings')}
          searchLabel={t('search')}
          clearLabel={t('clear')}
          clearHref={status ? `/admin/agents?status=${status}` : '/admin/agents'}
        />
        <nav className="flex flex-wrap gap-1" aria-label={t('agentListingStatusFilter')}>
          <Link
            href={filterHref()}
            aria-current={!status ? 'page' : undefined}
            className={!status ? 'ui-button-primary ui-button-sm' : 'ui-button-ghost ui-button-sm'}
          >
            {t('all')}
          </Link>
          {ADMIN_AGENT_LISTING_STATUSES.map((value) => (
            <Link
              key={value}
              href={filterHref(value)}
              aria-current={status === value ? 'page' : undefined}
              className={status === value ? 'ui-button-primary ui-button-sm' : 'ui-button-ghost ui-button-sm'}
            >
              {statusLabel(value)}
            </Link>
          ))}
        </nav>
      </div>

      {result.items.length === 0 ? (
        <AdminEmptyState
          icon={Bot}
          title={t('noAgentListings')}
          description={q || status ? t('noAgentListingsDescription') : t('emptyAgentListingsDescription')}
          actions={q || status ? null : (
            <Link href="/admin/agents/new" className="ui-button-primary">
              <Plus className="size-4" aria-hidden="true" />
              {t('addAgentTemplate')}
            </Link>
          )}
        />
      ) : (
        <DashboardTable
          ariaLabel={t('agentListingsTableLabel')}
          minWidth="76rem"
          headers={[
            { label: t('agentColumn'), className: 'w-full' },
            { label: t('publisherColumn') },
            { label: t('statusColumn') },
            { label: t('agentVersionColumn'), align: 'right' },
            { label: t('installsColumn'), align: 'right' },
            { label: t('flagsColumn') },
            { label: <span className="sr-only">{t('edit')}</span> },
          ]}
        >
          {result.items.map((listing) => {
            const orphanedPublisher = listing.publisherKind === 'workspace' && !listing.publisherWorkspaceId;
            return (
            <tr key={listing.id}>
              <td className="px-4 py-3">
                <AdminEntity
                  title={(
                    <Link href={`/admin/agents/${listing.id}/edit`} className="hover:underline">
                      {listing.name}
                    </Link>
                  )}
                  description={`/${listing.directorySlug}`}
                  initials={listing.name}
                />
              </td>
              <td className="max-w-56 px-4 py-3">
                <p className="truncate text-sm text-foreground">
                  {orphanedPublisher
                    ? t('agentPublisherWorkspaceRemoved')
                    : listing.author ?? listing.publisherWorkspace?.name ?? t('administrator')}
                </p>
                {listing.publisherWorkspace ? (
                  <code className="block truncate font-mono text-[11px] text-muted-foreground">
                    /{listing.publisherWorkspace.slug}
                  </code>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <div className="flex flex-col items-start gap-1">
                  <AdminBadge tone={statusTone(listing.status)} dot>{statusLabel(listing.status)}</AdminBadge>
                  {listing.pendingRelease ? (
                    <AdminBadge tone="warning">{t('agentPendingVersion', { version: listing.pendingRelease.version })}</AdminBadge>
                  ) : null}
                </div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {listing.latestVersion || '—'}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {listing.installCount.toLocaleString()}
              </td>
              <td className="px-4 py-3">
                <div className="flex min-w-36 flex-wrap gap-1.5">
                  {listing.isFeatured ? <AdminBadge tone="brand">{t('featured')}</AdminBadge> : null}
                  {listing.curated ? <AdminBadge tone="neutral">{t('curated')}</AdminBadge> : null}
                  {orphanedPublisher ? <AdminBadge tone="danger">{t('agentPublisherMissing')}</AdminBadge> : null}
                  {!listing.isFeatured && !listing.curated && !orphanedPublisher ? <span className="text-sm text-muted-foreground">{t('none')}</span> : null}
                </div>
              </td>
              <td className="px-2 py-3">
                <AdminTableLink
                  href={`/admin/agents/${listing.id}/edit`}
                  label={`${t('edit')}: ${listing.name}`}
                />
              </td>
            </tr>
            );
          })}
        </DashboardTable>
      )}

      <AdminPagination
        page={result.page}
        total={result.total}
        pageSize={result.pageSize}
        itemLabel={t('directoryAgents')}
        pageLabel={t('page')}
        previousLabel={t('prev')}
        nextLabel={t('next')}
        hrefForPage={hrefForPage}
      />
    </AdminPage>
  );
}
