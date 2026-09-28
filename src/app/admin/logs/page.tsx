/* eslint-disable react/jsx-key -- DashboardTable consumes cell arrays as indexed values. */

import { Button, ButtonLink } from '@/components/motion/button';
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalTrigger } from '@/components/motion/center-morph-modal';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Activity, ArrowDown, ArrowUpRight, Bot, ChevronDown, ChevronRight, CircleAlert, Clock3, Download, Gauge, RefreshCw, ScrollText, Server, ShieldCheck } from 'lucide-react';
import { DashboardTable } from '@/components/dashboard/DashboardUI';
import type { Prisma } from '@prisma/client';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/db';
import { AdminBadge, AdminEmptyState, AdminMetric, AdminPage, AdminPageHeader } from '@/components/admin/AdminUI';
import { LogFilters } from '@/components/admin/LogFilters';
import { LogOutcomeBadge, LogTimestamp } from '@/components/admin/LogUI';
import { aggregateLogs, auditWhere, authorizeLogs, cursorWhere, getErrorGroups, listLogEvents, logCursor, logFilterSchema } from '@/lib/observability/queries';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';
import { getLogSettings } from '@/lib/observability/settings';
import { logHealth } from '@/lib/observability/events';
import { LogSettings } from '@/components/admin/LogSettings';

export const dynamic = 'force-dynamic';

const tabs = [
  { value: 'http', icon: Activity }, { value: 'agent', icon: Bot },
  { value: 'runtime', icon: Server }, { value: 'audit', icon: ShieldCheck },
] as const;

export default async function AdminLogsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin();
  const [t, locale] = await Promise.all([getTranslations('admin'), getLocale()]);
  const raw = Object.fromEntries(Object.entries(await searchParams).filter(([, value]) => Boolean(value)));
  const tab = tabs.some(({ value }) => value === raw.tab) ? raw.tab! : 'http';
  const parsed = logFilterSchema.safeParse({ ...raw, domain: raw.domain ?? (tab === 'audit' ? undefined : tab) });
  if (!parsed.success) return <AdminPage>
    <AdminPageHeader title={t('logsTitle')} />
    <p role="alert" className="text-sm text-destructive">{t('logsInvalidFilter')}</p>
    <ButtonLink href="/admin/logs" variant="secondary" size="md">{t('logsReset')}</ButtonLink>
  </AdminPage>;
  const filters = parsed.data;
  const observedAt = new Date().getTime();
  const scope = { adminId: admin.id };
  await authorizeLogs(scope);
  const auditFilter = auditWhere(filters);
  const [events, audits, settings, groups, stats, auditCount] = await Promise.all([
    tab !== 'audit' ? listLogEvents(scope, filters) : null,
    tab === 'audit' ? db.auditEvent.findMany({
      where: { AND: [auditFilter, cursorWhere(filters.cursor) as Prisma.AuditEventWhereInput] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51,
    }) : null,
    getLogSettings(),
    tab !== 'audit' ? getErrorGroups(scope, filters) : [],
    tab !== 'audit' ? aggregateLogs(filters) : null,
    tab === 'audit' ? db.auditEvent.count({ where: auditFilter }) : 0,
  ]);
  const visibleAudits = audits?.slice(0, 50);
  const workspaceIds = [...new Set([
    ...(events?.rows ?? visibleAudits ?? []).flatMap((row) => row.workspaceId ? [row.workspaceId] : []),
    ...(visibleAudits ?? []).filter((row) => row.targetType === 'workspace').map((row) => row.targetId),
  ])];
  const workspaces = new Map((workspaceIds.length ? await db.workspace.findMany({
    where: { id: { in: workspaceIds } }, select: { id: true, name: true },
  }) : []).map((workspace) => [workspace.id, workspace.name]));
  const userIds = [...new Set((visibleAudits ?? []).flatMap((row) => [row.actorId, ...(row.targetType === 'user' ? [row.targetId] : [])]))];
  const users = new Map((userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : []).map((user) => [user.id, user.name ?? user.email]));
  const query = new URLSearchParams(Object.entries(raw) as Array<[string, string]>);
  query.set('since', filters.since.toISOString());
  query.set('until', filters.until.toISOString());
  const listHref = `/admin/logs?${query}`;
  const detailHref = (id: string) => adminHref(`/admin/logs/${id}`, { returnTo: listHref });
  const next = events?.nextCursor ?? (audits && audits.length > 50 ? logCursor(audits[49]) : null);
  const nextQuery = new URLSearchParams(query);
  if (next) nextQuery.set('cursor', next);
  const refreshQuery = new URLSearchParams(Object.entries(raw).filter(([key]) => !['cursor', 'until'].includes(key)) as Array<[string, string]>);
  const number = (value: number) => value.toLocaleString(locale);
  const rowCount = events?.rows.length ?? visibleAudits?.length ?? 0;
  const windowFormat = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  return <AdminPage>
    <AdminPageHeader title={t('logsTitle')} backHref={raw.returnTo ? adminReturnHref(raw.returnTo, '/admin') : undefined} backLabel={t('viewDetails')} meta={<AdminBadge>{t(`logsTab_${tab}`)}</AdminBadge>} actions={<>
      <ButtonLink href={`/api/v1/admin/logs/export?${query}`} title={t('logsExport')} variant="secondary" size="md"><Download className="size-4" aria-hidden="true" />{t('logsExportShort')}</ButtonLink>
      <ButtonLink href={`/admin/logs?${refreshQuery}`} aria-label={t('logsRefresh')} title={t('logsRefresh')} variant="secondary" size="icon"><RefreshCw className="size-4" aria-hidden="true" /></ButtonLink>
    </>} />

    <nav aria-label={t('logsViews')} className="flex flex-wrap gap-1">
      {tabs.map(({ value, icon: Icon }) => {
        const tabQuery = new URLSearchParams({ tab: value });
        for (const key of ['q', 'workspaceId', 'actorId', 'requestId', 'traceId', 'since', 'until']) {
          if (raw[key]) tabQuery.set(key, raw[key]);
        }
        return <ButtonLink key={value} href={`/admin/logs?${tabQuery}`} variant={tab === value ? "primary" : "ghost"} aria-current={tab === value ? "page" : undefined}><Icon className="hidden size-4 sm:block" aria-hidden="true" />{t(`logsTab_${value}`)}</ButtonLink>;
      })}
    </nav>

    {stats ? <section aria-label={t('logsSummary')} className="grid grid-cols-2 gap-px border-y border-border bg-border xl:grid-cols-4">
      <AdminMetric icon={ScrollText} label={t('logsTotal')} value={number(stats.total)} note={t('logsFilteredWindow')} />
      <AdminMetric icon={CircleAlert} label={t('logsFailures')} value={number(stats.errors)} valueClassName={stats.errors ? 'text-destructive' : undefined} note={t('logsFailureTypes')} />
      <AdminMetric icon={Gauge} label={t('logsErrorRate')} value={stats.total ? `${((stats.errors / stats.total) * 100).toFixed(1)}%` : '-'} note={t('logsFilteredWindow')} />
      <AdminMetric icon={Clock3} label={t('p95Latency')} value={stats.total ? `${number(stats.p95Ms)} ms` : '-'} note={t('logsAverage', { value: number(stats.avgMs) })} />
    </section> : null}

    <LogFilters tab={tab} raw={raw} filters={filters} observedAt={observedAt} />

    {logHealth.failures > 0 || logHealth.dropped > 0 ? <p role="status" className="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />{t('logsWriteHealth', { failures: logHealth.failures, dropped: logHealth.dropped })}
    </p> : null}

    {groups.length ? <details className="group border-l-2 border-destructive/60 bg-destructive/5 px-4">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
        <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        <span className="font-medium">{t('logsErrors')}</span><AdminBadge tone="danger">{groups.length}</AdminBadge>
        <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="divide-y divide-border pb-2">{groups.map((group, index) => {
        const groupQuery = new URLSearchParams(query);
        for (const key of ['cursor', 'errorType', 'errorCode']) groupQuery.delete(key);
        groupQuery.set('eventName', group.eventName);
        groupQuery.set('outcome', group.outcome);
        if (group.errorType) groupQuery.set('errorType', group.errorType);
        if (group.errorCode) groupQuery.set('errorCode', group.errorCode);
        return <Link key={index} href={`/admin/logs?${groupQuery}`} className="flex flex-wrap items-center gap-3 py-3 text-xs hover:text-destructive">
          <span className="min-w-0 flex-1 basis-48"><span className="block break-all font-mono font-medium">{group.errorType ?? group.eventName}{group.errorCode ? ` / ${group.errorCode}` : ''}</span><span className="mt-1 block break-all text-muted-foreground">{group.eventName}</span></span>
          <span className="text-muted-foreground" title={`${group.first.toISOString()} / ${group.last.toISOString()}`}>{t('logsAffectedWorkspaces', { count: group.workspaces })}</span>
          <AdminBadge tone="danger">{t('logsOccurrences', { count: group.count })}</AdminBadge><ArrowUpRight className="size-4" aria-hidden="true" />
        </Link>;
      })}</div>
    </details> : null}

    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">{t(tab === 'audit' ? 'logsTab_audit' : 'logsEvents')}<AdminBadge>{number(stats?.total ?? auditCount)}</AdminBadge></h2>
        <span className="text-xs text-muted-foreground">{windowFormat.format(filters.since)} - {windowFormat.format(filters.until)} UTC</span>
      </div>
      {rowCount ? <DashboardTable ariaLabel={t('logsEvents')}
minWidth="52rem"
className="rounded-md"
headers={[
        { label: t('logsTime'), width: "9rem" }, { label: t('logsResult'), width: "7rem" },
        { label: t('logsEvent') }, { label: t('logsResource'), width: "12rem" },
        { label: tab === 'audit' ? t('logFields.actorId') : t('logsDuration'), align: 'right' },
        { label: <span className="sr-only">{t('logsDetails')}</span> },
      ]}
rows={[...(events?.rows.map((row) => ({ id: row.id, cells: [<> <LogTimestamp date={row.createdAt} /> </>,
<> <LogOutcomeBadge outcome={row.outcome} />{row.httpStatus !== null ? <span className="mt-1 block font-mono text-xs text-muted-foreground">HTTP {row.httpStatus}</span> : null} </>,
<div className="min-w-0 max-w-sm"><> <Link href={detailHref(row.id)} className="block truncate font-medium text-foreground hover:underline" title={row.message}>{row.message}</Link><span className="mt-1 block truncate font-mono text-xs text-muted-foreground" title={row.eventName}>{row.eventName}{row.errorCode ? ` / ${row.errorCode}` : ''}</span> </></div>,
<div className="min-w-0 max-w-48"><> <span className="block truncate text-xs font-medium" title={row.toolName ?? row.model ?? row.deploymentId ?? row.agentId ?? ''}>{row.toolName ?? row.model ?? (row.deploymentId ? t('deployments') : row.agentId ? t('agents') : t.has(`logDomains.${row.domain}`) ? t(`logDomains.${row.domain}`) : row.domain)}</span>{row.workspaceId ? <Link href={adminHref(`/admin/workspaces/${row.workspaceId}`, { returnTo: listHref })} className="mt-1 block truncate text-xs text-muted-foreground hover:underline" title={row.workspaceId}>{workspaces.get(row.workspaceId) ?? row.workspaceId}</Link> : <span className="mt-1 block text-xs text-muted-foreground">{t('logsPlatform')}</span>} </></div>,
row.durationMs === null ? '-' : `${number(row.durationMs)} ms`,
<ButtonLink href={detailHref(row.id)} aria-label={t('logsDetails')} title={t('logsDetails')} variant="ghost" size="icon"><ChevronRight className="size-4" aria-hidden="true" /></ButtonLink>] })) ?? []), ...(visibleAudits?.map((row) => ({ id: row.id, cells: [<> <LogTimestamp date={row.createdAt} /> </>,
<> <LogOutcomeBadge outcome={row.outcome} /> </>,
<div className="min-w-0 max-w-sm"><CenterMorphModal><CenterMorphModalTrigger><Button variant="ghost" size="sm" className="max-w-full"><span className="truncate">{row.action}</span></Button></CenterMorphModalTrigger><CenterMorphModalContent ariaLabel={row.action} closeButtonLabel={t('cancel')} className="max-w-2xl"><div className="space-y-4 p-6"><h2 className="pr-8 text-sm font-semibold">{row.action}</h2><pre tabIndex={0} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-6">{JSON.stringify({ actorId: row.actorId, requestId: row.requestId, traceId: row.traceId, changes: row.changes }, null, 2)}</pre></div></CenterMorphModalContent></CenterMorphModal></div>,
<div className="min-w-0 max-w-48"><> <span className="block text-xs font-medium">{row.targetType}</span>{row.targetType === 'user' && users.has(row.targetId) ? <Link href={adminHref(`/admin/users/${row.targetId}`, { returnTo: listHref })} className="mt-1 block truncate text-xs hover:underline">{users.get(row.targetId)}</Link>
              : row.targetType === 'workspace' && workspaces.has(row.targetId) ? <Link href={adminHref(`/admin/workspaces/${row.targetId}`, { returnTo: listHref })} className="mt-1 block truncate text-xs hover:underline">{workspaces.get(row.targetId)}</Link>
              : <span className="mt-1 block truncate font-mono text-xs text-muted-foreground" title={row.targetId}>{row.targetId}</span>} </></div>,
<div className="min-w-0 max-w-40">{users.has(row.actorId) ? <Link href={adminHref(`/admin/users/${row.actorId}`, { returnTo: listHref })} className="hover:underline">{users.get(row.actorId)}</Link> : row.actorId}</div>,
null] })) ?? [])]} /> : <AdminEmptyState icon={ScrollText} title={t('logsEmpty')} description={t('logsEmptyHint')} actions={<ButtonLink href={`/admin/logs?tab=${tab}`} variant="secondary" size="md">{t('logsReset')}</ButtonLink>} />}
      <nav aria-label={t('page')} className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t('logsPageCount', { count: rowCount })}</span>{next ? <ButtonLink href={`/admin/logs?${nextQuery}`} variant="secondary" size="md">{t('logsNext')}<ArrowDown className="size-4" aria-hidden="true" /></ButtonLink> : null}</nav>
    </section>

    <LogSettings settings={{ ...settings, captures: settings.captures.filter((item) => new Date(item.expiresAt).getTime() > observedAt) }} />
  </AdminPage>;
}
