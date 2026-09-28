/* eslint-disable react/jsx-key -- DashboardTable consumes cell arrays as indexed values. */
import { Button, ButtonLink } from '@/components/motion/button';
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalTrigger } from '@/components/motion/center-morph-modal';
import { FormSelect } from '@/components/ui/FormSelect';
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
      actions={<ButtonLink href="/admin/market" variant="secondary" size="md"><Library className="size-4" />{ops('catalog')}</ButtonLink>} />
    <AdminSearchForm defaultValue={q} placeholder={t('marketCatalogSearchPlaceholder')} label={t('search')} searchLabel={t('search')} clearLabel={t('clear')} clearHref="/admin/reviews">
      <FormSelect name="status" defaultValue={result.status} className="w-auto" label={t('statusColumn')} options={[...(REVIEW_STATUSES.map((value) => ({ value: value, label: ops(value) })))]} />
      <FormSelect name="kind" defaultValue={result.kind} className="w-auto" label={ops('allKinds')} options={[{ value: "", label: ops('allKinds') }, ...(REVIEW_KINDS.map((value) => ({ value: value, label: value })))]} />
    </AdminSearchForm>
    {result.items.length ? <DashboardTable ariaLabel={ops('reviewQueue')}
minWidth="64rem"
headers={[
      { label: t('name'), width: "35%" }, { label: t('marketReleasePublisher') }, { label: ops('submittedAt') },
      { label: ops('reviewer') }, { label: ops('reviewNote') }, { label: <span className="sr-only">{ops('review')}</span> },
    ]}
rows={result.items.map((row) => ({ id: `${row.source}-${row.id}`, cells: [<div className="min-w-0 max-w-80"><> <Link href={detailHref(row)} className="block truncate font-medium hover:underline">{row.name}</Link><span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><AdminBadge>{row.kind}</AdminBadge>v{row.version}</span> </></div>,
<div className="min-w-0 max-w-48">{row.publisher ?? '-'}</div>,
<> <LogTimestamp date={row.submittedAt} /> </>,
<div className="min-w-0 max-w-48"><> <span className="block truncate text-sm">{row.reviewer ?? '-'}</span>{row.reviewedAt ? <LogTimestamp date={row.reviewedAt} /> : null} </></div>,
<div className="min-w-0 max-w-64">{row.reviewNote ? <CenterMorphModal><CenterMorphModalTrigger><Button variant="ghost" size="sm" className="max-w-full"><span className="truncate">{row.reviewNote}</span></Button></CenterMorphModalTrigger><CenterMorphModalContent ariaLabel={ops('reviewNote')} closeButtonLabel={t('cancel')} className="max-w-2xl"><div className="space-y-4 p-6"><h2 className="pr-8 text-sm font-semibold">{ops('reviewNote')}</h2><p tabIndex={0} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm">{row.reviewNote}</p></div></CenterMorphModalContent></CenterMorphModal> : '-'}</div>,
<> <AdminTableLink href={detailHref(row)} label={`${ops('review')}: ${row.name}`} /> </>] }))} /> : <AdminEmptyState icon={ClipboardCheck} title={t('none')} description={ops('noPendingWork')} />}
    <AdminPagination {...result} itemLabel={t('items')} pageLabel={t('page')} previousLabel={t('prev')} nextLabel={t('next')} hrefForPage={hrefForPage} />
  </AdminPage>;
}
