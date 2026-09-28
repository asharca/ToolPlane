/* eslint-disable react/jsx-key -- DashboardTable consumes cell arrays as indexed values. */

import { ButtonLink } from '@/components/motion/button';
import { Plus, Server as ServerIcon } from 'lucide-react';
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
import { listDirectoryServers } from '@/lib/admin/market';
import { normalizeAdminPage } from '@/lib/admin/pagination';
import { adminHref } from '@/lib/admin/navigation';
import { requireAdmin } from '@/lib/auth/admin';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

export default async function AdminServersPage({
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
  } = await listDirectoryServers({ page: requestedPage, q });

  const hrefForPage = (targetPage: number) => {
    const query = new URLSearchParams({ page: String(targetPage) });
    if (q) query.set('q', q);
    return `/admin/servers?${query.toString()}`;
  };
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (rawQuery !== q || rawPage !== requestedPage || currentPage > lastPage) {
    redirect(hrefForPage(Math.min(currentPage, lastPage)));
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title={t('directoryServers')}
        description={t('serversDescription')}
        meta={t('serverCount', { count: total.toLocaleString() })}
        actions={
          <ButtonLink href="/admin/servers/new" variant="primary" size="md">
            <Plus className="size-4" aria-hidden="true" />
            {t('addServer')}
          </ButtonLink>
        }
      />

      <AdminSearchForm
        defaultValue={q}
        placeholder={t('searchNameOrSlug')}
        label={t('searchNameOrSlug')}
        searchLabel={t('search')}
        clearLabel={t('clear')}
        clearHref="/admin/servers"
      />

      {items.length === 0 ? (
        <AdminEmptyState
          icon={ServerIcon}
          title={t('noServers')}
          description={q ? t('noServersDescription') : t('emptyServersDescription')}
          actions={q ? null : (
            <ButtonLink href="/admin/servers/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden="true" />
              {t('addServer')}
            </ButtonLink>
          )}
        />
      ) : (
        <DashboardTable ariaLabel={t('serversTableLabel')}
minWidth="72rem"
headers={[
            { label: t('serverColumn'), width: "35%" },
            { label: t('verificationColumn') },
            { label: t('starsColumn'), align: 'right' },
            { label: t('deploymentsColumn'), align: 'right' },
            { label: t('flagsColumn') },
            { label: <span className="sr-only">{t('edit')}</span> },
          ]}
rows={items.map((server) => (
            ({ id: server.id, cells: [<> <AdminEntity
                  title={
                    <Link
                      href={adminHref(`/admin/servers/${server.id}/edit`, { returnTo: hrefForPage(currentPage) })}
                      className="hover:underline"
                    >
                      {server.name}
                    </Link>
                  }
                  description={`/${server.slug}`}
                  initials={server.name}
                /> </>,
server.verifiedAt ? (
                  <div className="flex flex-col items-start gap-1">
                    <AdminBadge tone="success" dot>
                      {t('verified')}
                    </AdminBadge>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatInTimeZone(server.verifiedAt, timeZone, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }, locale)}
                    </span>
                  </div>
                ) : (
                  <AdminBadge tone="warning" dot>
                    {t('unverified')}
                  </AdminBadge>
                ),
server.stars.toLocaleString(),
server._count.deployments,
<div className="flex min-w-52 flex-wrap gap-1.5">
                  {server.isOfficial ? (
                    <AdminBadge tone="info">{t('official')}</AdminBadge>
                  ) : null}
                  {server.isFeatured ? (
                    <AdminBadge tone="neutral">{t('featured')}</AdminBadge>
                  ) : null}
                  {server.curated ? (
                    <AdminBadge tone="neutral">{t('curated')}</AdminBadge>
                  ) : null}
                  {!server.isOfficial && !server.isFeatured && !server.curated ? (
                    <span className="text-sm text-muted-foreground">{t('none')}</span>
                  ) : null}
                </div>,
<> <AdminTableLink
                  href={adminHref(`/admin/servers/${server.id}/edit`, { returnTo: hrefForPage(currentPage) })}
                  label={`${t('edit')}: ${server.name}`}
                /> </>] })
          ))} />
      )}

      <AdminPagination
        page={currentPage}
        total={total}
        pageSize={pageSize}
        itemLabel={t('directoryServers')}
        pageLabel={t('page')}
        previousLabel={t('prev')}
        nextLabel={t('next')}
        hrefForPage={hrefForPage}
      />
    </AdminPage>
  );
}
