import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Activity, ArrowDown, ArrowUpRight, Bot, ChevronDown, ChevronRight, CircleAlert, Clock3, Download, Gauge, RefreshCw, ScrollText, Server, ShieldCheck } from 'lucide-react';
import { Alert, DataTable, Pagination, Tab, TabList } from '@asharca/ui';
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
    <Alert tone="danger">{t('logsInvalidFilter')}</Alert>
    <Link href="/admin/logs" className="ui-button-secondary">{t('logsReset')}</Link>
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
      <Link href={`/api/v1/admin/logs/export?${query}`} className="ui-button-secondary" title={t('logsExport')}><Download className="size-4" aria-hidden="true" />{t('logsExportShort')}</Link>
      <Link href={`/admin/logs?${refreshQuery}`} aria-label={t('logsRefresh')} title={t('logsRefresh')} className="ui-button-secondary ui-icon-button"><RefreshCw className="size-4" aria-hidden="true" /></Link>
    </>} />

    <TabList navigation label={t('logsViews')} className="w-full rounded-md sm:w-auto">
      {tabs.map(({ value, icon: Icon }) => {
        const tabQuery = new URLSearchParams({ tab: value });
        for (const key of ['q', 'workspaceId', 'actorId', 'requestId', 'traceId', 'since', 'until']) {
          if (raw[key]) tabQuery.set(key, raw[key]);
        }
        return <Tab key={value} asChild navigation current={tab === value} className="min-h-10 flex-1 justify-center rounded px-2.5 sm:px-4">
          <Link href={`/admin/logs?${tabQuery}`}><Icon className="hidden size-4 sm:block" aria-hidden="true" />{t(`logsTab_${value}`)}</Link>
        </Tab>;
      })}
    </TabList>

    {stats ? <section aria-label={t('logsSummary')} className="grid grid-cols-2 gap-px border-y border-border bg-border xl:grid-cols-4">
      <AdminMetric icon={ScrollText} label={t('logsTotal')} value={number(stats.total)} note={t('logsFilteredWindow')} />
      <AdminMetric icon={CircleAlert} label={t('logsFailures')} value={number(stats.errors)} valueClassName={stats.errors ? 'text-destructive-text' : undefined} note={t('logsFailureTypes')} />
      <AdminMetric icon={Gauge} label={t('logsErrorRate')} value={stats.total ? `${((stats.errors / stats.total) * 100).toFixed(1)}%` : '-'} note={t('logsFilteredWindow')} />
      <AdminMetric icon={Clock3} label={t('p95Latency')} value={stats.total ? `${number(stats.p95Ms)} ms` : '-'} note={t('logsAverage', { value: number(stats.avgMs) })} />
    </section> : null}

    <LogFilters tab={tab} raw={raw} filters={filters} observedAt={observedAt} />

    {logHealth.failures > 0 || logHealth.dropped > 0 ? <Alert tone="danger" role="status">
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />{t('logsWriteHealth', { failures: logHealth.failures, dropped: logHealth.dropped })}
    </Alert> : null}

    {groups.length ? <details className="group border-l-2 border-destructive/60 bg-destructive/5 px-4">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
        <CircleAlert className="size-4 shrink-0 text-destructive-text" aria-hidden="true" />
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
        return <Link key={index} href={`/admin/logs?${groupQuery}`} className="flex flex-wrap items-center gap-3 py-3 text-xs hover:text-destructive-text">
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
      {rowCount ? <DataTable label={t('logsEvents')} minWidth="52rem" className="rounded-md" headers={[
        { label: t('logsTime'), className: 'w-36' }, { label: t('logsResult'), className: 'w-28' },
        { label: t('logsEvent') }, { label: t('logsResource'), className: 'w-48' },
        { label: tab === 'audit' ? t('logFields.actorId') : t('logsDuration'), align: 'right' },
        { label: <span className="sr-only">{t('logsDetails')}</span> },
      ]}>
        {events?.rows.map((row) => <tr key={row.id}>
          <td className="px-4 py-3"><LogTimestamp date={row.createdAt} /></td>
          <td className="px-4 py-3"><LogOutcomeBadge outcome={row.outcome} />{row.httpStatus !== null ? <span className="mt-1 block font-mono text-xs text-muted-foreground">HTTP {row.httpStatus}</span> : null}</td>
          <td className="max-w-sm px-4 py-3">
            <Link href={detailHref(row.id)} className="block truncate font-medium text-foreground hover:underline" title={row.message}>{row.message}</Link>
            <span className="mt-1 block truncate font-mono text-xs text-muted-foreground" title={row.eventName}>{row.eventName}{row.errorCode ? ` / ${row.errorCode}` : ''}</span>
          </td>
          <td className="max-w-48 px-4 py-3">
            <span className="block truncate text-xs font-medium" title={row.toolName ?? row.model ?? row.deploymentId ?? row.agentId ?? ''}>{row.toolName ?? row.model ?? (row.deploymentId ? t('deployments') : row.agentId ? t('agents') : t.has(`logDomains.${row.domain}`) ? t(`logDomains.${row.domain}`) : row.domain)}</span>
            {row.workspaceId ? <Link href={adminHref(`/admin/workspaces/${row.workspaceId}`, { returnTo: listHref })} className="mt-1 block truncate text-xs text-muted-foreground hover:underline" title={row.workspaceId}>{workspaces.get(row.workspaceId) ?? row.workspaceId}</Link> : <span className="mt-1 block text-xs text-muted-foreground">{t('logsPlatform')}</span>}
          </td>
          <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs tabular-nums">{row.durationMs === null ? '-' : `${number(row.durationMs)} ms`}</td>
          <td className="px-2 py-3"><Link href={detailHref(row.id)} className="ui-button-ghost ui-icon-button" aria-label={t('logsDetails')} title={t('logsDetails')}><ChevronRight className="size-4" aria-hidden="true" /></Link></td>
        </tr>)}
        {visibleAudits?.map((row) => <tr key={row.id}>
          <td className="px-4 py-3"><LogTimestamp date={row.createdAt} /></td>
          <td className="px-4 py-3"><LogOutcomeBadge outcome={row.outcome} /></td>
          <td className="max-w-sm px-4 py-3"><details>
            <summary className="cursor-pointer break-all font-mono text-xs font-medium">{row.action}</summary>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all bg-muted/50 p-3 text-xs leading-relaxed">{JSON.stringify({ actorId: row.actorId, requestId: row.requestId, traceId: row.traceId, changes: row.changes }, null, 2)}</pre>
          </details></td>
          <td className="max-w-48 px-4 py-3"><span className="block text-xs font-medium">{row.targetType}</span>
            {row.targetType === 'user' && users.has(row.targetId) ? <Link href={adminHref(`/admin/users/${row.targetId}`, { returnTo: listHref })} className="mt-1 block truncate text-xs hover:underline">{users.get(row.targetId)}</Link>
              : row.targetType === 'workspace' && workspaces.has(row.targetId) ? <Link href={adminHref(`/admin/workspaces/${row.targetId}`, { returnTo: listHref })} className="mt-1 block truncate text-xs hover:underline">{workspaces.get(row.targetId)}</Link>
              : <span className="mt-1 block truncate font-mono text-xs text-muted-foreground" title={row.targetId}>{row.targetId}</span>}
          </td>
          <td colSpan={2} className="max-w-40 truncate px-4 py-3 text-right text-xs text-muted-foreground" title={row.actorId}>{users.has(row.actorId) ? <Link href={adminHref(`/admin/users/${row.actorId}`, { returnTo: listHref })} className="hover:underline">{users.get(row.actorId)}</Link> : row.actorId}</td>
        </tr>)}
      </DataTable> : <AdminEmptyState icon={ScrollText} title={t('logsEmpty')} description={t('logsEmptyHint')} actions={<Link href={`/admin/logs?tab=${tab}`} className="ui-button-secondary">{t('logsReset')}</Link>} />}
      <Pagination summary={t('logsPageCount', { count: rowCount })} next={next ? <Link href={`/admin/logs?${nextQuery}`} className="ui-button-secondary">{t('logsNext')}<ArrowDown className="size-4" aria-hidden="true" /></Link> : null} />
    </section>

    <LogSettings settings={{ ...settings, captures: settings.captures.filter((item) => new Date(item.expiresAt).getTime() > observedAt) }} />
  </AdminPage>;
}
