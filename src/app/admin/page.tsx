import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Activity, ArrowUpRight, Building2, ClipboardCheck, CircleAlert } from 'lucide-react';
import { requireAdmin } from '@/lib/auth/admin';
import { getSystemOverview } from '@/lib/admin/overview';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { AdminBadge, AdminMetric, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';
import { LogOutcomeBadge, LogTimestamp } from '@/components/admin/LogUI';
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
  const hasRequestData = o.requests.total > 0;
  const errorRate = hasRequestData ? (o.requests.errors / o.requests.total) * 100 : null;
  const deploymentLabels: Record<string, string> = {
    running: t('deploymentStatusRunning'), provisioning: t('deploymentStatusProvisioning'),
    stopped: t('deploymentStatusStopped'), error: t('deploymentStatusError'),
  };
  const requestsHref = '/admin/logs?domain=mcp&eventName=gateway.request';

  return (
    <AdminPage>
      <AdminPageHeader title={t('systemOverview')} description={t('overviewDescription')} actions={
        <Link href="/admin/logs" className="ui-button-secondary"><Activity className="size-4" aria-hidden="true" />{t('overviewViewLogs')}</Link>
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
        <AdminPanel
          title={ops('mcpHealth')}
          actions={
            <AdminBadge tone={!hasRequestData ? 'neutral' : o.requests.errors === 0 ? 'success' : 'danger'} dot>
              {!hasRequestData
                ? t('noRequestData')
                : o.requests.errors === 0
                ? t('noRequestErrors')
                : t('requestErrorsRecorded', { count: o.requests.errors })}
            </AdminBadge>
          }
          padded={false}
        >
          <dl className="grid sm:grid-cols-3">
            {[
              {
                label: t('errors24h'),
                value: o.requests.errors.toLocaleString(),
                note: errorRate === null ? t('noRequestData') : `${errorRate.toFixed(1)}%`,
              },
              {
                label: t('p95Latency'),
                value: hasRequestData ? `${o.requests.p95Ms.toLocaleString()} ms` : '—',
                note: t('last24Hours'),
              },
              {
                label: t('averageLatency'),
                value: hasRequestData ? `${o.requests.avgMs.toLocaleString()} ms` : '—',
                note: t('last24Hours'),
              },
            ].map((item, index) => (
              <div
                key={item.label}
                className={`px-4 py-5 ${index > 0 ? 'border-t border-border sm:border-l sm:border-t-0' : ''}`}
              >
                <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
                <dd className={`mt-3 text-2xl font-semibold tabular-nums ${index === 0 && o.requests.errors ? 'text-destructive-text' : 'text-foreground'}`}>{item.value}</dd>
                <dd className="mt-1 text-xs text-muted-foreground">{item.note}</dd>
              </div>
            ))}
          </dl>
          <Link href={requestsHref} className="ui-button-ghost mt-2 text-xs">{t('overviewViewLogs')}<ArrowUpRight className="size-3.5" aria-hidden="true" /></Link>
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
          actions={<Link href="/admin/users" className="ui-button-ghost text-xs">{t('overviewAllUsers')}<ArrowUpRight className="size-3.5" aria-hidden="true" /></Link>}
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
                      {u.role === 'admin' ? <AdminBadge tone="brand">{t('admin')}</AdminBadge> : null}
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
              <progress aria-label={deploymentLabels[status] ?? status} value={count} max={deployTotal} className={`block h-1.5 w-full overflow-hidden rounded [&::-webkit-progress-bar]:bg-muted ${status === 'running' ? 'accent-brand [&::-webkit-progress-value]:bg-brand' : status === 'error' || status === 'failed' ? 'accent-destructive-text [&::-webkit-progress-value]:bg-destructive-text' : 'accent-muted-foreground [&::-webkit-progress-value]:bg-muted-foreground'}`} />
            </div>
          ))}</dl> : <p className="py-6 text-sm text-muted-foreground">{t('overviewNoDeployments')}</p>}
        </AdminPanel>
      </div>
    </AdminPage>
  );
}
