import Link from 'next/link';
import { ClipboardCheck, Library } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { AdminBadge, AdminEmptyState, AdminPage, AdminPageHeader, AdminPagination, AdminSearchForm, AdminTableLink } from '@/components/admin/AdminUI';
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import { LogTimestamp } from '@/components/admin/LogUI';
import { listAdminReviews, REVIEW_KINDS, REVIEW_STATUSES } from '@/lib/admin/reviews';
import { adminHref } from '@/lib/admin/navigation';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export default async function AdminReviewsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; kind?: string; page?: string }> }) {
  await requireAdmin();
  const [t, ops, query] = await Promise.all([getTranslations('admin'), getTranslations('adminOps'), searchParams]);
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
  const result = await listAdminReviews({ q, status: query.status, kind: query.kind, page: Number(query.page ?? 1) });
  const hrefForPage = (page: number) => adminHref('/admin/reviews', { q, status: result.status, kind: result.kind, page: String(page) });
  if (query.page && Number(query.page) !== result.page) redirect(hrefForPage(result.page));
  const listHref = hrefForPage(result.page);
  const detailHref = (row: typeof result.items[number]) => adminHref(row.source === 'agent' ? `/admin/agents/${row.listingId}/edit` : `/admin/reviews/market/${row.listingId}`, { releaseId: row.id, returnTo: listHref });
  return <AdminPage>
    <AdminPageHeader title={ops('reviewQueue')} meta={<AdminBadge tone={result.status === 'pending' ? 'warning' : 'neutral'}>{result.total}</AdminBadge>}
      actions={<Link href="/admin/market" className="ui-button-secondary"><Library className="size-4" />{ops('catalog')}</Link>} />
    <AdminSearchForm defaultValue={q} placeholder={t('marketCatalogSearchPlaceholder')} label={t('search')} searchLabel={t('search')} clearLabel={t('clear')} clearHref="/admin/reviews">
      <select name="status" defaultValue={result.status} aria-label={t('statusColumn')} className="ui-input h-11 w-auto sm:h-9">{REVIEW_STATUSES.map((value) => <option key={value} value={value}>{ops(value)}</option>)}</select>
      <select name="kind" defaultValue={result.kind} aria-label={ops('allKinds')} className="ui-input h-11 w-auto sm:h-9"><option value="">{ops('allKinds')}</option>{REVIEW_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select>
    </AdminSearchForm>
    {result.items.length ? <DashboardTable ariaLabel={ops('reviewQueue')} minWidth="64rem" headers={[
      { label: t('name'), className: 'w-full' }, { label: t('marketReleasePublisher') }, { label: ops('submittedAt') },
      { label: ops('reviewer') }, { label: ops('reviewNote') }, { label: <span className="sr-only">{ops('review')}</span> },
    ]}>{result.items.map((row) => <tr key={`${row.source}-${row.id}`}>
      <td className="max-w-80 px-4 py-3"><Link href={detailHref(row)} className="block truncate font-medium hover:underline">{row.name}</Link><span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><AdminBadge>{row.kind}</AdminBadge>v{row.version}</span></td>
      <td className="max-w-48 truncate px-4 py-3 text-sm" title={row.publisher ?? ''}>{row.publisher ?? '-'}</td>
      <td className="px-4 py-3"><LogTimestamp date={row.submittedAt} /></td>
      <td className="max-w-48 px-4 py-3"><span className="block truncate text-sm">{row.reviewer ?? '-'}</span>{row.reviewedAt ? <LogTimestamp date={row.reviewedAt} /> : null}</td>
      <td className="max-w-64 px-4 py-3 text-xs">{row.reviewNote ? <details><summary className="cursor-pointer truncate">{row.reviewNote}</summary><p className="mt-2 whitespace-pre-wrap break-words">{row.reviewNote}</p></details> : '-'}</td>
      <td className="px-2 py-3"><AdminTableLink href={detailHref(row)} label={`${ops('review')}: ${row.name}`} /></td>
    </tr>)}</DashboardTable> : <AdminEmptyState icon={ClipboardCheck} title={t('none')} description={ops('noPendingWork')} />}
    <AdminPagination {...result} itemLabel={t('items')} pageLabel={t('page')} previousLabel={t('prev')} nextLabel={t('next')} hrefForPage={hrefForPage} />
  </AdminPage>;
}
