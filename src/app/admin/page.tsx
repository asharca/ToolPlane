/* eslint-disable react/jsx-key -- DashboardTable consumes cell arrays as indexed values. */

import { ButtonLink } from '@/components/motion/button';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Activity, ArrowUpRight, Building2, ClipboardCheck, CircleAlert } from 'lucide-react';
import { requireAdmin } from '@/lib/auth/admin';
import { getSystemOverview } from '@/lib/admin/overview';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { AdminBadge, AdminMetric, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { LogOutcomeBadge, LogTimestamp } from '@/components/admin/LogUI';
import { DashboardTable } from '@/components/dashboard/DashboardTable';
import { adminHref } from '@/lib/admin/navigation';

export const dynamic = 'force-dynamic';

function InventoryGroup({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; value: number }>;
}) {
  return (
    <div className="px-4 py-2">
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{title}</h3>
      <dl className="space-y-1">
        {items.map((item) => (
          <div key={item.label} className="flex min-h-8 items-center justify-between gap-4 text-sm">
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="font-semibold tabular-nums text-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default async function AdminOverviewPage() {
  const [t, locale] = await Promise.all([getTranslations('admin'), getLocale()]);
  const admin = await requireAdmin();
  const timeZone = resolveUserTimeZone(admin);
  const o = await getSystemOverview();
  const ops = await getTranslations('adminOps');
  const deployTotal = Object.values(o.counts.deployments).reduce((a, b) => a + b, 0);
  const deploymentLabels: Record<string, string> = {
    running: t('deploymentStatusRunning'), provisioning: t('deploymentStatusProvisioning'),
    stopped: t('deploymentStatusStopped'), error: t('deploymentStatusError'),
  };
  const requestsHref = '/admin/logs?domain=mcp&eventName=gateway.request';
  const a2aRequestsHref = '/admin/logs?tab=a2a&direction=inbound';

  return (
    <AdminPage>
      <AdminPageHeader title={t('systemOverview')} description={t('overviewDescription')} actions={
        <ButtonLink href="/admin/logs" variant="secondary" size="md"><Activity className="size-4" aria-hidden="true" />{t('overviewViewLogs')}</ButtonLink>
      } />

      <section className="grid grid-cols-2 gap-px border-y border-border bg-border xl:grid-cols-4">
        <AdminMetric
          icon={ClipboardCheck}
          label={ops('pendingReviews')}
          value={o.attention.pendingReviews.toLocaleString()}
          href="/admin/reviews"
          note={ops('reviewQueue')}
        />
        <AdminMetric
          icon={Building2}
          label={t('workspaces')}
          value={o.counts.workspaces.toLocaleString()}
          href="/admin/workspaces"
          note={t('workspaceMemberships', { count: o.counts.memberships.toLocaleString() })}
        />
        <AdminMetric
          icon={CircleAlert}
          label={ops('abnormalDeployments')}
          value={o.attention.abnormalCount.toLocaleString()}
          href="#needs-attention"
          note={ops('runtimeStatus')}
        />
        <AdminMetric
          icon={Activity}
          label={ops('mcpRequests')}
          value={o.requests.total.toLocaleString()}
          href={requestsHref}
          note={t('errorsInWindow', { count: o.requests.errors.toLocaleString() })}
        />
      </section>

      <div id="needs-attention" className="grid min-w-0 gap-8 xl:grid-cols-2">
        <AdminPanel title={ops('needsAttention')} padded={false}>
          <ul className="divide-y divide-border">
            <li><Link href="/admin/reviews" className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-muted/50"><span>{ops('pendingReviews')}</span><AdminBadge tone={o.attention.pendingReviews ? 'warning' : 'neutral'}>{o.attention.pendingReviews}</AdminBadge></Link></li>
            {o.attention.unavailableWorkspaces ? <li><Link href="/admin/workspaces?status=delete_failed" className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-muted/50"><span>{t('workspaces')} / {ops('delete_failed')}</span><AdminBadge tone="danger">{o.attention.unavailableWorkspaces}</AdminBadge></Link></li> : null}
            {o.attention.abnormalDeployments.map((deployment) => <li key={deployment.id}><Link href={adminHref('/admin/logs', { domain: 'all', deploymentId: deployment.id, workspaceId: deployment.workspaceId, returnTo: '/admin' })} className="flex min-w-0 items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50"><span className="min-w-0"><span className="block truncate text-sm font-medium">{deployment.name ?? deployment.id}</span><span className="block truncate text-xs text-muted-foreground">{deployment.workspace.name}</span></span><AdminBadge tone="danger">{deploymentLabels[deployment.status] ?? deployment.status}</AdminBadge></Link></li>)}
          </ul>
          {!o.attention.pendingReviews && !o.attention.abnormalCount && !o.attention.unavailableWorkspaces ? <p className="px-5 py-6 text-sm text-muted-foreground">{ops('noPendingWork')}</p> : null}
        </AdminPanel>
        <AdminPanel title={ops('recentFailures')} description={t('last24Hours')} padded={false}>
          {o.attention.recentFailures.length ? <ul className="divide-y divide-border">{o.attention.recentFailures.map((event) => <li key={event.id}><Link href={adminHref(`/admin/logs/${event.id}`, { returnTo: '/admin' })} className="flex min-w-0 flex-wrap items-center gap-3 px-5 py-3 hover:bg-muted/50"><LogOutcomeBadge outcome={event.outcome} /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{event.message}</span><code className="block truncate text-xs text-muted-foreground">{event.eventName}</code></span><LogTimestamp date={event.createdAt} /></Link></li>)}</ul> : <p className="px-5 py-6 text-sm text-muted-foreground">{ops('noErrors')}</p>}
        </AdminPanel>
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,.65fr)]">
        <AdminPanel title={t('logsRequestTriage')} description={t('last24Hours')} padded={false}>
          <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            {[
              { label: ops('mcpRequests'), stats: o.requests, href: requestsHref },
              { label: t('logsA2aRequests'), stats: o.a2aRequests, href: a2aRequestsHref },
            ].map(({ label, stats, href }) => (
              <div key={href} className="min-w-0 px-5 py-4">
                <h3 className="mb-3 text-sm font-semibold">{label}</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('requests24h')}</dt><dd className="font-semibold tabular-nums">{stats.total.toLocaleString()}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('errors24h')}</dt><dd className={`font-semibold tabular-nums ${stats.errors ? 'text-destructive' : ''}`}>{stats.errors.toLocaleString()}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('p95Latency')}</dt><dd className="tabular-nums">{stats.total ? `${stats.p95Ms.toLocaleString()} ms` : t('noRequestData')}</dd></div>
                </dl>
                <ButtonLink href={href} variant="ghost" size="md" className="mt-3">{t('overviewViewLogs')}<ArrowUpRight className="size-3.5" aria-hidden="true" /></ButtonLink>
              </div>
            ))}
          </div>
          <div className="min-w-0 border-t border-border">
            <h3 className="px-5 py-4 text-sm font-semibold">{t('logsRecentRequests')}</h3>
            {o.recentRequests.length ? <DashboardTable
              ariaLabel={t('logsRecentRequests')}
              minWidth="42rem"
              headers={[
                { label: t('logsTime') }, { label: t('logsOperation') }, { label: t('logsUserClient') },
                { label: t('logsResult') }, { label: t('logsDuration'), align: 'right' },
              ]}
              rows={o.recentRequests.map(event => ({ id: event.id, cells: [
                <LogTimestamp date={event.createdAt} />,
                <Link href={adminHref(`/admin/logs/${event.id}`, { returnTo: '/admin' })} className="block min-w-0 max-w-56 hover:underline"><span className="block text-xs text-muted-foreground">{event.domain === 'a2a' ? 'A2A' : 'MCP'}</span><span className="block truncate font-medium">{event.rpcMethod ?? event.toolName ?? event.eventName}</span></Link>,
                <span className="block max-w-48 truncate">{event.actorId ? <><span className="block truncate">{event.actorName ?? event.actorId}</span>{event.actorName ? <code className="block truncate text-xs text-muted-foreground">{event.actorId}</code> : null}</> : event.clientId ? <><span className="block text-xs text-muted-foreground">{t('logsServiceClient')}</span><code className="block truncate">{event.clientId}</code></> : t('logsUnknownCaller')}</span>,
                <LogOutcomeBadge outcome={event.outcome} />,
                <span className="whitespace-nowrap tabular-nums">{event.durationMs === null ? '—' : `${event.durationMs.toLocaleString()} ms`}</span>,
              ] }))}
            /> : <p className="px-5 pb-6 text-sm text-muted-foreground">{t('noRequestData')}</p>}
          </div>
        </AdminPanel>

        <AdminPanel title={t('resourceInventory')} description={t('currentTotals')} padded={false}>
          <div className="grid sm:grid-cols-2 xl:grid-cols-2 [&>*+*]:border-t [&>*+*]:border-border sm:[&>*+*]:border-l sm:[&>*+*]:border-t-0">
            <InventoryGroup
              title={t('runtime')}
              items={[
                { label: t('users'), value: o.counts.users },
                { label: t('agents'), value: o.counts.agents },
                { label: t('toolkits'), value: o.counts.toolkits },
                { label: t('installedSkills'), value: o.counts.installedSkills },
                { label: t('modelProviders'), value: o.counts.providers },
              ]}
            />
            <InventoryGroup
              title={t('directory')}
              items={[
                { label: t('directoryServers'), value: o.counts.servers },
                { label: t('directorySkills'), value: o.counts.skills },
                { label: t('directoryAgents'), value: o.counts.agentListings },
                { label: t('clients'), value: o.counts.clients },
                { label: t('categories'), value: o.counts.categories },
              ]}
            />
          </div>
        </AdminPanel>
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,.65fr)]">
        <AdminPanel
          title={t('recentSignups')}
          description={t('latestAccounts', { count: o.recentUsers.length })}
          actions={<ButtonLink href="/admin/users" variant="ghost" size="md">{t('overviewAllUsers')}<ArrowUpRight className="size-3.5" aria-hidden="true" /></ButtonLink>}
          padded={false}
        >
          {o.recentUsers.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">{t('noRecentSignups')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {o.recentUsers.map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="flex min-h-12 items-center justify-between gap-4 px-5 py-2.5 transition-colors hover:bg-accent/35"
                  >
                    <span className="flex min-w-0 items-center gap-3"><span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">{(u.name ?? u.email).slice(0, 2).toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-sm font-medium text-foreground">{u.name ?? u.email}</span>{u.name ? <span className="block truncate text-xs text-muted-foreground">{u.email}</span> : null}</span></span>
                    <span className="flex shrink-0 items-center gap-2">
                      {u.role === 'admin' ? <AdminBadge tone="info">{t('admin')}</AdminBadge> : null}
                      {u.status === 'suspended' ? <AdminBadge tone="warning">{t('suspended')}</AdminBadge> : null}
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        {formatInTimeZone(u.createdAt, timeZone, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                      }, locale)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>
        <AdminPanel title={t('overviewDeploymentStatus')} actions={<AdminBadge>{deployTotal}</AdminBadge>}>
          {deployTotal ? <dl className="space-y-5">{Object.entries(o.counts.deployments).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
            <div key={status}>
              <div className="mb-2 flex items-center justify-between gap-3 text-sm"><dt>{deploymentLabels[status] ?? status}</dt><dd className="font-semibold tabular-nums">{count.toLocaleString(locale)}</dd></div>
              <progress aria-label={deploymentLabels[status] ?? status} value={count} max={deployTotal} className={`block h-1.5 w-full overflow-hidden rounded [&::-webkit-progress-bar]:bg-muted ${status === 'running' ? 'accent-primary [&::-webkit-progress-value]:bg-primary' : status === 'error' || status === 'failed' ? 'accent-destructive [&::-webkit-progress-value]:bg-destructive' : 'accent-muted-foreground [&::-webkit-progress-value]:bg-muted-foreground'}`} />
            </div>
          ))}</dl> : <p className="py-6 text-sm text-muted-foreground">{t('overviewNoDeployments')}</p>}
        </AdminPanel>
      </div>
    </AdminPage>
  );
}
