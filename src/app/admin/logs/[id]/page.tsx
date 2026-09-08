import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { Alert, CopyButton } from '@asharca/ui';
import { ChevronDown, ChevronRight, FileJson, GitBranch, ScrollText } from 'lucide-react';
import { AdminBadge, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { LogOutcomeBadge, LogTimestamp } from '@/components/admin/LogUI';
import { getLogEvent, getLogTrace } from '@/lib/observability/queries';
import { writeAudit } from '@/lib/observability/audit';
import { db } from '@/lib/db';
import { adminHref, adminReturnHref } from '@/lib/admin/navigation';

export const dynamic = 'force-dynamic';

export default async function LogDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const admin = await requireAdmin();
  const t = await getTranslations('admin');
  const event = await getLogEvent({ adminId: admin.id }, (await params).id);
  if (!event) notFound();
  const backHref = adminReturnHref((await searchParams).returnTo, '/admin/logs');
  const selfHref = adminHref(`/admin/logs/${event.id}`, { returnTo: backHref });
  const [workspace, actor] = await Promise.all([
    event.workspaceId ? db.workspace.findUnique({ where: { id: event.workspaceId }, select: { id: true, name: true } }) : null,
    event.actorId ? db.user.findUnique({ where: { id: event.actorId }, select: { id: true, email: true, name: true } }) : null,
  ]);
  const ops = await getTranslations('adminOps');
  const observedAt = new Date().getTime();
  // Do not disclose the payload unless its access audit was durably written.
  if (event.detail) await writeAudit(db, { actorId: admin.id, workspaceId: event.workspaceId ?? undefined,
    action: 'logging.detail.viewed', targetType: 'logEvent', targetId: event.id });
  const trace = await getLogTrace({ adminId: admin.id }, event.traceId);
  const { detail, ...metadata } = event;
  const contextKeys = ['workspaceId', 'actorId', 'agentId', 'deploymentId', 'runId', 'conversationId', 'channelId', 'providerId', 'model', 'method', 'path', 'rpcMethod', 'toolName', 'errorType', 'errorCode'] as const;
  const context = contextKeys.filter((key) => event[key] !== null);
  return <AdminPage>
    <AdminPageHeader title={event.eventName} description={<span className="break-words [overflow-wrap:anywhere]">{event.message}</span>}
      meta={<LogOutcomeBadge outcome={event.outcome} />} backHref={backHref} backLabel={t('logsTitle')}
      actions={<CopyButton text={event.id} label={t('logsCopyEventId')} copiedLabel={t('logsCopied')} failedLabel={t('logsCopyFailed')} />} />

    <dl className="grid grid-cols-2 gap-px border-y border-border bg-border xl:grid-cols-4">
      {[
        { label: t('logsTime'), value: <LogTimestamp date={event.createdAt} /> },
        { label: t('logFields.domain'), value: <AdminBadge>{t.has(`logDomains.${event.domain}`) ? t(`logDomains.${event.domain}`) : event.domain}</AdminBadge> },
        { label: t('logsDuration'), value: event.durationMs === null ? '-' : `${event.durationMs} ms` },
        { label: t('logFields.httpStatus'), value: event.httpStatus ?? '-' },
      ].map(({ label, value }) => <div key={label} className="min-w-0 bg-background px-4 py-4 sm:px-5">
        <dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-2 text-sm font-semibold tabular-nums">{value}</dd>
      </div>)}
    </dl>

    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
      <div className="min-w-0 space-y-6">
        <AdminPanel title={<span className="flex items-center gap-2"><FileJson className="size-4 text-muted-foreground" aria-hidden="true" />{t('logsDiagnosticDetail')}</span>}
          actions={detail ? <AdminBadge tone={detail.truncated ? 'warning' : 'neutral'}>{t(detail.truncated ? 'logsTruncated' : 'logsCaptured')}</AdminBadge> : undefined}>
          {detail ? <>
            <pre tabIndex={0} aria-label={t('logsDiagnosticDetail')} className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-4 font-mono text-xs leading-6">{JSON.stringify(detail.data, null, 2)}</pre>
            <p className="mt-3 break-words text-xs text-muted-foreground">{t('logsExpires')}: {detail.expiresAt.toISOString()}</p>
          </> : <div className="flex min-h-32 items-center justify-center gap-2 bg-muted/30 px-4 text-sm text-muted-foreground"><ScrollText className="size-4 shrink-0" aria-hidden="true" />{t('logsNoDetail')}</div>}
        </AdminPanel>

        {event.attributes !== null ? <details className="group border-t border-border pt-3">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-sm font-semibold [&::-webkit-details-marker]:hidden">{t('logsAttributes')}<ChevronDown className="size-4 text-muted-foreground group-open:rotate-180" aria-hidden="true" /></summary>
          <pre tabIndex={0} className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-4 font-mono text-xs leading-6">{JSON.stringify(event.attributes, null, 2)}</pre>
        </details> : null}

        <AdminPanel title={<span className="flex items-center gap-2"><GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />{t('logsTrace')}</span>}
          actions={<AdminBadge>{t('logsTraceCount', { count: Math.min(trace.length, 500) })}</AdminBadge>}>
          {trace.length > 500 ? <Alert tone="warning" role="status" className="mb-4">{t('logsTruncated')}</Alert> : null}
          <ol className="ml-2 border-l border-border">{trace.slice(0, 500).map((row) => <li key={row.id} className="relative pl-5">
            <span aria-hidden="true" className={`absolute -left-[4.5px] top-5 size-2 rounded-full ring-4 ring-background ${row.outcome === 'error' ? 'bg-destructive-text' : row.outcome === 'success' ? 'bg-brand' : 'bg-muted-foreground'}`} />
            <Link href={adminHref(`/admin/logs/${row.id}`, { returnTo: backHref })} aria-current={row.id === event.id ? 'step' : undefined} className={`block rounded-md p-3 transition-colors hover:bg-muted/50 ${row.id === event.id ? 'bg-muted/50 ring-1 ring-border' : ''}`}>
              <span className="flex flex-wrap items-center justify-between gap-2"><LogTimestamp date={row.createdAt} compact /><LogOutcomeBadge outcome={row.outcome} /></span>
              <span className="mt-2 block break-all font-mono text-xs font-semibold">{row.eventName}</span>
              <span className="mt-1 block break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{row.toolName ?? row.model ?? row.message}</span>
              <span className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span className="font-mono tabular-nums">{row.durationMs === null ? '-' : `${row.durationMs} ms`}</span><ChevronRight className="size-3.5" aria-hidden="true" /></span>
            </Link>
          </li>)}</ol>
        </AdminPanel>
      </div>

      <aside className="min-w-0 space-y-6" aria-label={t('logsMetadata')}>
        <AdminPanel title={ops('related')}>
          <div className="space-y-3 text-sm">
            {workspace ? <Link href={adminHref(`/admin/workspaces/${workspace.id}`, { returnTo: selfHref })} className="block break-words text-brand hover:underline">{t('workspaces')}: {workspace.name}</Link> : null}
            {actor ? <Link href={adminHref(`/admin/users/${actor.id}`, { returnTo: selfHref })} className="block break-all text-brand hover:underline">{t('user')}: {actor.name ?? actor.email}</Link> : null}
            {(['deploymentId', 'agentId'] as const).filter((key) => event[key]).map((key) => <Link key={key} href={adminHref('/admin/logs', { domain: 'all', [key]: event[key]!, returnTo: selfHref })} className="block text-brand hover:underline">{t(`logFields.${key}`)} / {ops('activity')}</Link>)}
            <Link href={adminHref('/admin/logs', { tab: 'audit', traceId: event.traceId, since: new Date(event.createdAt.getTime() - 3600_000).toISOString(), until: new Date(Math.min(observedAt, event.createdAt.getTime() + 86400_000)).toISOString(), returnTo: selfHref })} className="block text-brand hover:underline">{ops('audit')}</Link>
          </div>
        </AdminPanel>
        <AdminPanel title={t('logsCorrelation')}>
          <dl className="space-y-4">{(['requestId', 'traceId'] as const).filter((key) => event[key]).map((key) => <div key={key}>
            <dt className="text-xs font-medium text-muted-foreground">{t(`logFields.${key}`)}</dt>
            <dd className="mt-1 flex min-w-0 items-start gap-2"><code className="min-w-0 flex-1 break-all pt-1.5 text-xs leading-5">{event[key]}</code><CopyButton text={event[key]!} iconOnly label={t('logsCopyField', { field: t(`logFields.${key}`) })} copiedLabel={t('logsCopied')} failedLabel={t('logsCopyFailed')} /></dd>
          </div>)}</dl>
        </AdminPanel>
        {context.length ? <AdminPanel title={t('logsMetadata')}>
          <dl className="divide-y divide-border">{context.map((key) => <div key={key} className="py-3 first:pt-0">
            <dt className="text-xs font-medium text-muted-foreground">{t(`logFields.${key}`)}</dt><dd className="mt-1.5 break-all font-mono text-xs leading-5">{event[key]}</dd>
          </div>)}</dl>
        </AdminPanel> : null}
        <details className="group border-t border-border pt-3">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-sm font-semibold [&::-webkit-details-marker]:hidden">{t('logsRawMetadata')}<ChevronDown className="size-4 text-muted-foreground group-open:rotate-180" aria-hidden="true" /></summary>
          <pre tabIndex={0} className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-4 font-mono text-xs leading-6">{JSON.stringify(metadata, null, 2)}</pre>
        </details>
      </aside>
    </div>
  </AdminPage>;
}
