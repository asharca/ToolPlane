import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { CopyButton } from '@/components/dashboard/CopyButton';
import { LogPayload } from '@/components/dashboard/LogPayload';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { AdminBadge, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { LogOutcomeBadge, LogTimestamp } from '@/components/admin/LogUI';
import { getLogEvent, getLogTrace, getA2aMetadata } from '@/lib/observability/queries';
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
  const a2a = getA2aMetadata(event.attributes);
  const [workspace, actor, agent, endpoint] = await Promise.all([
    event.workspaceId ? db.workspace.findUnique({ where: { id: event.workspaceId }, select: { id: true, name: true } }) : null,
    event.actorId ? db.user.findUnique({ where: { id: event.actorId }, select: { id: true, email: true, name: true } }) : null,
    event.agentId && event.workspaceId ? db.agent.findFirst({ where: { id: event.agentId, workspaceId: event.workspaceId }, select: { name: true } }) : null,
    a2a?.endpointId && event.workspaceId ? db.agentEndpoint.findFirst({ where: { id: a2a.endpointId, workspaceId: event.workspaceId }, select: { name: true } }) : null,
  ]);
  const ops = await getTranslations('adminOps');
  const observedAt = new Date().getTime();
  const trace = await getLogTrace({ adminId: admin.id }, event.traceId);
  const { detail, ...metadata } = event;
  const contextKeys = ['workspaceId', 'actorId', 'agentId', 'deploymentId', 'runId', 'conversationId', 'channelId', 'providerId', 'model', 'method', 'path', 'rpcMethod', 'toolName', 'errorType', 'errorCode'] as const;
  const context = contextKeys.filter((key) => event[key] !== null);
  const data = detail?.data && typeof detail.data === 'object' && !Array.isArray(detail.data) ? detail.data as Record<string, unknown> : null;
  const candidate = data?.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) ? data.payload as Record<string, unknown> : null;
  const payload = candidate && ['request', 'response', 'responseKind'].some(key => Object.hasOwn(candidate, key)) ? candidate : null;
  const readable = event.detailState === 'available' || event.detailState === 'truncated';
  const bodyUnavailable = t(event.detailState === 'expired' ? 'logsBodyExpired' : event.detailState === 'restricted' ? 'logsBodyRestricted' : 'logsBodyUnavailable');
  const requestBody = readable && payload && Object.hasOwn(payload, 'request') ? JSON.stringify(payload.request, null, 2) : null;
  const responseBody = readable && payload && Object.hasOwn(payload, 'response') ? JSON.stringify(payload.response, null, 2) : null;
  const responseUnavailable = payload?.responseKind === 'none' ? t(payload.responseComplete ? 'logsNoResponseBody' : 'logsNoResponseReceived') : bodyUnavailable;
  const errorResponse = payload?.response && typeof payload.response === 'object' && 'error' in payload.response ? payload.response.error : null;
  const errorDetail = data?.error ?? errorResponse;
  const httpEntry = event.requestId ? trace.find(row => row.domain === 'http' && row.eventName === 'http.request' && row.requestId === event.requestId) : undefined;
  const target = agent?.name ?? endpoint?.name ?? event.agentId ?? a2a?.endpointId ?? a2a?.remoteAgentId ?? event.deploymentId;
  const caller = actor?.name ?? actor?.email ?? event.actorId ?? (a2a?.clientId ? `${t('logsServiceClient')} · ${a2a.clientId}` : t('logsPlatform'));
  const correlations = { requestId: event.requestId, traceId: event.traceId, taskId: a2a?.taskId, contextId: a2a?.contextId, rootTaskId: a2a?.rootTaskId, parentTaskId: a2a?.parentTaskId };
  const correlationHref = (key: string, value: string) => adminHref('/admin/logs', { domain: key === 'requestId' || key === 'traceId' ? 'all' : 'a2a',
    ...(key === 'requestId' || key === 'traceId' ? {} : { tab: 'a2a' }), [key]: value,
    since: new Date(event.createdAt.getTime() - 3600_000).toISOString(), until: new Date(Math.min(observedAt, event.createdAt.getTime() + 86400_000)).toISOString() });
  return <AdminPage>
    <AdminPageHeader title={event.rpcMethod ?? event.toolName ?? event.eventName} description={<span className="break-words [overflow-wrap:anywhere]">{event.eventName}</span>}
      meta={<><LogOutcomeBadge outcome={event.outcome} />{a2a?.taskState ? <AdminBadge>{t(`logsTaskStates.${a2a.taskState}`)}</AdminBadge> : null}</>} backHref={backHref} backLabel={t('logsTitle')}
      actions={<CopyButton text={event.id} label={t('logsCopyEventId')} />} />

    <dl className="grid grid-cols-2 gap-px border-y border-border bg-border xl:grid-cols-4">
      {[
        { label: t('logsTime'), value: <LogTimestamp date={event.createdAt} /> },
        { label: t('logFields.domain'), value: <AdminBadge>{t.has(`logDomains.${event.domain}`) ? t(`logDomains.${event.domain}`) : event.domain}</AdminBadge> },
        { label: t(event.eventName === 'a2a.task.settled' ? 'logsTaskDuration' : 'logsDuration'), value: event.durationMs === null ? '-' : `${event.durationMs} ms` },
        { label: t('logFields.httpStatus'), value: event.httpStatus === null ? t('logsNoHttp') : `HTTP ${event.httpStatus}` },
        { label: t('logsUserClient'), value: <span className="break-all">{caller}</span> },
        { label: t('logsWorkspaceTarget'), value: <span className="break-all">{workspace?.name ?? event.workspaceId ?? t('logsPlatform')} / {target ?? t('logsNoTarget')}</span> },
        { label: t('logsHttpEntry'), value: <code className="break-all">{httpEntry?.path ?? t('logsNoHttpEntry')}</code> },
        { label: t('logFields.direction'), value: a2a ? t(`logsDirections.${a2a.direction}`) : '—' },
      ].map(({ label, value }) => <div key={label} className="min-w-0 bg-background px-4 py-4 sm:px-5">
        <dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-2 text-sm font-semibold tabular-nums">{value}</dd>
      </div>)}
    </dl>

    <section aria-label={t('logsCorrelation')} className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Object.entries(correlations).flatMap(([key, value]) => value ? [<div key={key} className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{t(`logFields.${key}`)}</p>
        <div className="mt-1 flex min-w-0 items-start gap-2"><Link href={correlationHref(key, value)} className="min-w-0 flex-1 break-all pt-1.5 font-mono text-xs text-primary hover:underline">{value}</Link>
          <CopyButton text={value} iconOnly label={t('logsCopyField', { field: t(`logFields.${key}`) })} /></div>
      </div>] : [])}
    </section>

    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
      <div className="min-w-0 space-y-6">
        <AdminPanel title={t('logsDiagnosticDetail')} actions={<AdminBadge tone={event.detailState === 'truncated' ? 'warning' : 'neutral'}>{t(`logsDetailStates.${event.detailState}`)}</AdminBadge>}>
          {payload || event.eventName === 'a2a.request' ? <>
            <div className={`grid min-w-0 gap-6 ${event.eventName === 'a2a.request' || requestBody !== null ? 'xl:grid-cols-2' : ''}`}>
              {event.eventName === 'a2a.request' || requestBody !== null ? <LogPayload label={t('logsRequestBody')} value={requestBody} copyLabel={t('logsCopyPayload', { label: t('logsRequestBody') })} unavailableText={bodyUnavailable} /> : null}
              <div className="min-w-0 space-y-3">
                {payload?.responseKind === 'sse' ? <p className="text-xs text-muted-foreground">{t('logsSseResponse')} · {t(detail?.truncated ? 'logsResponseTruncated' : payload.responseComplete ? 'logsResponseComplete' : 'logsResponseDisconnected')}</p> : null}
                <LogPayload label={t('logsResponseBody')} value={responseBody} copyLabel={t('logsCopyPayload', { label: t('logsResponseBody') })} unavailableText={responseUnavailable} />
              </div>
            </div>
          </> : detail ? <LogPayload label={t('logsDiagnosticDetail')} value={JSON.stringify(detail.data, null, 2)} copyLabel={t('logsCopyPayload', { label: t('logsDiagnosticDetail') })} unavailableText={bodyUnavailable} />
            : <p className="py-6 text-sm text-muted-foreground">{bodyUnavailable}</p>}
          {detail ? <p className="mt-4 break-words text-xs text-muted-foreground">{t('logsExpires')}: {detail.expiresAt.toISOString()}</p> : null}
        </AdminPanel>

        {errorDetail !== null && errorDetail !== undefined ? <AdminPanel title={t('logsErrorDetail')}>
          <LogPayload label={t('logsErrorDetail')} value={JSON.stringify(errorDetail, null, 2)} copyLabel={t('logsCopyPayload', { label: t('logsErrorDetail') })} unavailableText={bodyUnavailable} />
        </AdminPanel> : a2a?.rpcErrorCode !== undefined ? <AdminPanel title={t('logsErrorDetail')}><code>{t('logFields.rpcErrorCode')}: {a2a.rpcErrorCode}</code></AdminPanel> : null}


        <AdminPanel title={<span className="flex items-center gap-2"><GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />{t('logsTrace')}</span>}
          actions={<AdminBadge>{t('logsTraceCount', { count: Math.min(trace.length, 500) })}</AdminBadge>}>
          {trace.length > 500 ? <p role="status" className="mb-4 text-sm text-muted-foreground">{t('logsTruncated')}</p> : null}
          <ol className="ml-2 border-l border-border">{trace.slice(0, 500).map((row) => <li key={row.id} className="relative pl-5">
            <span aria-hidden="true" className={`absolute -left-[4.5px] top-5 size-2 rounded-full ring-4 ring-background ${row.outcome === 'error' ? 'bg-destructive' : row.outcome === 'success' ? 'bg-primary' : 'bg-muted-foreground'}`} />
            <Link href={adminHref(`/admin/logs/${row.id}`, { returnTo: backHref })} aria-current={row.id === event.id ? 'step' : undefined} className={`block rounded-md p-3 transition-colors hover:bg-muted/50 ${row.id === event.id ? 'bg-muted/50 ring-1 ring-border' : ''}`}>
              <span className="flex flex-wrap items-center justify-between gap-2"><LogTimestamp date={row.createdAt} compact /><LogOutcomeBadge outcome={row.outcome} /></span>
              <span className="mt-2 block break-all font-mono text-xs font-semibold">{row.eventName}</span>
              <span className="mt-1 block break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{row.toolName ?? row.model ?? row.message}</span>
              <span className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span className="font-mono tabular-nums">{row.durationMs === null ? '-' : `${row.durationMs} ms`}</span><ChevronRight className="size-3.5" aria-hidden="true" /></span>
            </Link>
          </li>)}</ol>
        </AdminPanel>
        {event.attributes !== null ? <details className="group border-t border-border pt-3">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-sm font-semibold [&::-webkit-details-marker]:hidden">{t('logsAttributes')}<ChevronDown className="size-4 text-muted-foreground group-open:rotate-180" aria-hidden="true" /></summary>
          <pre tabIndex={0} className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-4 font-mono text-xs leading-6">{JSON.stringify(event.attributes, null, 2)}</pre>
        </details> : null}
      </div>

      <aside className="min-w-0 space-y-6" aria-label={t('logsMetadata')}>
        <AdminPanel title={ops('related')}>
          <div className="space-y-3 text-sm">
            {workspace ? <Link href={adminHref(`/admin/workspaces/${workspace.id}`, { returnTo: selfHref })} className="block break-words text-primary hover:underline">{t('workspaces')}: {workspace.name}</Link> : null}
            {actor ? <Link href={adminHref(`/admin/users/${actor.id}`, { returnTo: selfHref })} className="block break-all text-primary hover:underline">{t('user')}: {actor.name ?? actor.email}</Link> : null}
            {(['deploymentId', 'agentId'] as const).filter((key) => event[key]).map((key) => <Link key={key} href={adminHref('/admin/logs', { domain: 'all', [key]: event[key]!, returnTo: selfHref })} className="block text-primary hover:underline">{t(`logFields.${key}`)} / {ops('activity')}</Link>)}
            <Link href={adminHref('/admin/logs', { tab: 'audit', traceId: event.traceId, since: new Date(event.createdAt.getTime() - 3600_000).toISOString(), until: new Date(Math.min(observedAt, event.createdAt.getTime() + 86400_000)).toISOString(), returnTo: selfHref })} className="block text-primary hover:underline">{ops('audit')}</Link>
          </div>
        </AdminPanel>
        {context.length ? <AdminPanel title={t('logsMetadata')}>
          <dl className="divide-y divide-border">{context.map((key) => <div key={key} className="py-3 first:pt-0">
            <dt className="text-xs font-medium text-muted-foreground">{t(`logFields.${key}`)}</dt><dd className="mt-1.5 break-all font-mono text-xs leading-5">{event[key]}</dd>
          </div>)}</dl>
        </AdminPanel> : null}
        <details className="group border-t border-border pt-3">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-sm font-semibold [&::-webkit-details-marker]:hidden">{t('logsRawMetadata')}<ChevronDown className="size-4 text-muted-foreground group-open:rotate-180" aria-hidden="true" /></summary>
          <pre tabIndex={0} className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-4 font-mono text-xs leading-6">{JSON.stringify({ ...metadata, a2a }, null, 2)}</pre>
        </details>
      </aside>
    </div>
  </AdminPage>;
}
