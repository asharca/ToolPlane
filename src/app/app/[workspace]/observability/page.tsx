import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getObservability } from '@/lib/observability/log';
import { getPluginTelemetry } from '@/lib/observability/plugin-telemetry';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { TabBar } from '@/components/dashboard/TabBar';
import { ObservabilityLogs } from '@/components/dashboard/ObservabilityLogs';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPanel,
  DashboardTable,
  DashboardToolbar,
} from '@/components/dashboard/DashboardUI';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Stat({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub: string;
}) {
  return (
    <div className="ui-panel p-5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-3xl font-bold tracking-tight text-foreground">
          {value}
        </span>
        {unit ? (
          <span className="text-sm text-muted-foreground">{unit}</span>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

export default async function ObservabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string; deploymentId?: string }>;
}) {
  const [t, locale] = await Promise.all([
    getTranslations('console.observability'),
    getLocale(),
  ]);
  const { workspace: slug } = await params;
  const { tab, deploymentId } = await searchParams;
  const selectedDeploymentId = deploymentId?.trim() || undefined;
  const tabs = [
    { key: 'usage', label: t('usage') },
    { key: 'audit', label: t('auditLog') },
    { key: 'plugin', label: t('plugin') },
  ];
  const current = tabs.some((item) => item.key === tab) ? tab! : 'usage';

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const timeZone = resolveUserTimeZone(user);
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const o = await getObservability(ws.id, timeZone, 24, selectedDeploymentId);
  const pt = current === 'plugin' ? await getPluginTelemetry(ws.id) : null;
  const max = Math.max(1, ...o.series.map((s) => s.total));
  const errorRate = o.total ? (Math.round((o.errors / o.total) * 1000) / 10) : 0;
  const base = `/app/${slug}/observability`;
  const dateLocale = locale === 'zh' ? 'zh-CN' : 'en-US';
  const filterQuery = selectedDeploymentId ? { deploymentId: selectedDeploymentId } : undefined;

  return (
    <>
      <DashboardHeader title={t('observability')} />
      <DashboardPage>
        <TabBar tabs={tabs} current={current} basePath={base} query={filterQuery} />

        {current !== 'plugin' ? (
          <DashboardToolbar
            className="rounded-lg border border-border bg-muted/20 px-4 py-3"
            actions={(
              <form action={base} method="get" className="flex flex-wrap items-center gap-2">
                {current !== 'usage' ? <input type="hidden" name="tab" value={current} /> : null}
                <label htmlFor="observability-deployment" className="sr-only">
                  {t('filterByServer')}
                </label>
                <select
                  id="observability-deployment"
                  name="deploymentId"
                  defaultValue={selectedDeploymentId ?? ''}
                  className="ui-input h-9 min-w-52 text-sm"
                >
                  <option value="">{t('allServers')}</option>
                  {o.deployments.map((deployment) => (
                    <option key={deployment.id} value={deployment.id}>
                      {deployment.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="ui-button-secondary h-9 text-sm">
                  {t('applyFilter')}
                </button>
                {selectedDeploymentId ? (
                  <Link href={current === 'usage' ? base : `${base}?tab=${current}`} className="text-sm text-muted-foreground hover:text-foreground">
                    {t('clearFilter')}
                  </Link>
                ) : null}
              </form>
            )}
          >
            <div>
              <p className="text-sm text-muted-foreground">
                {t('toolCallsLatencyAndErrorsAcrossEveryServerAggregatedOverTheLast24Hours')}
              </p>
              {o.selectedDeployment ? (
                <p className="mt-1 text-xs font-medium text-foreground">
                  {t('filteredTo', { name: o.selectedDeployment })}
                </p>
              ) : null}
            </div>
          </DashboardToolbar>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('pluginTelemetryDescription')}
          </p>
        )}

        {current === 'usage' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={t('totalRequests24h')}
                value={compact(o.total)}
                sub={t('requestsReceived')}
              />
              <Stat
                label={t('errorRate')}
                value={errorRate}
                unit="%"
                sub={t('errorCount', { count: o.errors })}
              />
              <Stat
                label={t('avgLatency')}
                value={o.avgMs}
                unit="ms"
                sub={t('averageResponse')}
              />
              <Stat
                label={t('p95Latency')}
                value={o.p95Ms}
                unit="ms"
                sub={t('ninetyFifthPercentile')}
              />
            </div>

            <DashboardPanel title={t('requestsPerHour')}>
              <div className="mb-4 flex items-center justify-between">
                <div />
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-sky-500" />
                    {t('requests')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-red-400" />
                    {t('errors')}
                  </span>
                </div>
              </div>
              {o.total === 0 ? (
                <DashboardEmptyState
                  description={t('noTrafficYetCallADeploymentsGatewayEndpointToSeeActivityHere')}
                  className="min-h-48"
                />
              ) : (
                <div className="relative flex h-48 items-end gap-1 border-b border-border/70 pt-2">
                  {o.series.map((s, i) => {
                    const ok = s.total - s.errors;
                    const barHeight = s.total
                      ? Math.max(4, (s.total / max) * 82)
                      : 0;
                    return (
                      <div
                        key={i}
                        className="relative h-full flex-1"
                        title={t('chartTooltip', { hour: s.hour, total: s.total, errors: s.errors })}
                      >
                        <div
                          className="absolute inset-x-0 bottom-5 flex flex-col justify-end"
                          style={{ height: `${barHeight}%` }}
                        >
                          <div
                            className="w-full rounded-t-sm bg-sky-500"
                            style={{
                              height: `${(ok / Math.max(1, s.total)) * 100}%`,
                            }}
                          />
                          <div
                            className="w-full bg-red-400"
                            style={{
                              height: `${(s.errors / Math.max(1, s.total)) * 100}%`,
                            }}
                          />
                        </div>
                        <span className="absolute inset-x-0 bottom-0 truncate text-center text-[9px] text-muted-foreground">
                          {s.hour}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </DashboardPanel>

            <DashboardPanel
              title={t('requestsByServer')}
              description={t('requestsByServerDescription')}
              padded={false}
            >
              {o.deploymentUsage.length === 0 ? (
                <DashboardEmptyState
                  description={t('noServersYet')}
                  className="min-h-32 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  panel={false}
                  minWidth="42rem"
                  headers={[
                    { label: t('server') },
                    { label: t('requests'), align: 'right' },
                    { label: t('errors'), align: 'right' },
                    { label: t('errorRate'), align: 'right' },
                    { label: t('avgLatency'), align: 'right' },
                  ]}
                >
                  {o.deploymentUsage.map((row) => {
                    const rowErrorRate = row.total
                      ? `${Math.round((row.errors / row.total) * 1000) / 10}%`
                      : '—';
                    return (
                      <tr key={row.id ?? 'workspace-api'} className="hover:bg-muted/40">
                        <td className="px-4 py-3">
                          {row.id ? (
                            <Link
                              href={`/app/${slug}/mcp/${row.id}`}
                              className="font-medium text-foreground hover:underline"
                            >
                              {row.name}
                            </Link>
                          ) : (
                            <span className="font-medium text-foreground">{row.name}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-foreground">{row.total}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{row.errors}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{rowErrorRate}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{row.avgMs}{t('ms')}</td>
                      </tr>
                    );
                  })}
                </DashboardTable>
              )}
            </DashboardPanel>
          </>
        ) : current === 'audit' ? (
          <DashboardPanel
            title={t('auditLog')}
            description={t('showingRecentRequests', { count: o.recent.length })}
            padded={false}
          >
            {o.recent.length === 0 ? (
              <DashboardEmptyState
                description={t('noRequestsLoggedInTheLast24Hours')}
                className="min-h-48 rounded-none border-0"
              />
            ) : (
              <ObservabilityLogs
                logs={o.recent.map((log) => ({
                  ...log,
                  deploymentHref: log.deploymentId
                    ? `/app/${slug}/mcp/${log.deploymentId}`
                    : null,
                  time: formatInTimeZone(log.createdAt, timeZone, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    second: '2-digit',
                  }, dateLocale),
                }))}
                labels={{
                  expand: t('expandLog'),
                  collapse: t('collapseLog'),
                  server: t('server'),
                  path: t('path'),
                  method: t('method'),
                  status: t('status'),
                  duration: t('duration'),
                  time: t('time'),
                  request: t('request'),
                  response: t('response'),
                  openServer: t('openServer'),
                }}
              />
            )}
          </DashboardPanel>
        ) : pt ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={t('skillCalls24h')}
                value={compact(pt.skill.total)}
                sub={t('acrossInstalledPlugins')}
              />
              <Stat
                label={t('userAgent')}
                value={`${pt.skill.byUser} / ${pt.skill.byAgent}`}
                sub={t('slashVsAutonomous')}
              />
              <Stat
                label={t('skillErrors')}
                value={pt.skill.errors}
                sub={t('failedInvocations')}
              />
              <Stat
                label={t('skillSyncs')}
                value={pt.sync.applied}
                sub={t('failedCount', { count: pt.sync.failures })}
              />
            </div>

            <DashboardPanel title={t('recentSkillInvocations')} padded={false}>
              {pt.skill.recent.length === 0 ? (
                <DashboardEmptyState
                  description={t('noSkillInvocationsYetInstallAToolkitAsAnAutosyncPluginAndRunOneOfItsSkills')}
                  className="min-h-48 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  panel={false}
                  headers={[
                    { label: t('skill') },
                    { label: t('source') },
                    { label: t('outcome') },
                    { label: t('time') },
                  ]}
                >
                  {pt.skill.recent.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-2.5 font-mono text-xs text-foreground">
                        {s.skillSlug}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {s.source === 'user' ? t('user') : t('agent')}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={
                            s.outcome === 'error'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {s.outcome === 'error' ? t('error') : t('success')}
                          {s.errorClass ? ` · ${s.errorClass}` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {formatInTimeZone(s.createdAt, timeZone, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        }, dateLocale)}
                      </td>
                    </tr>
                  ))}
                </DashboardTable>
              )}
            </DashboardPanel>

            <DashboardPanel title={t('recentSkillSyncs')} padded={false}>
              {pt.sync.recent.length === 0 ? (
                <DashboardEmptyState
                  description={t('noSyncsRecordedYet')}
                  className="min-h-48 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  panel={false}
                  headers={[
                    { label: t('outcome') },
                    { label: t('added') },
                    { label: t('updated') },
                    { label: t('removed') },
                    { label: t('time') },
                  ]}
                >
                  {pt.sync.recent.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-2.5">
                        <span
                          className={
                            s.outcome === 'failure'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {s.outcome === 'failure'
                            ? `${t('failure')}${s.reason ? ` · ${s.reason}` : ''}`
                            : t('applied')}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {s.added}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {s.updated}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {s.removed}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {formatInTimeZone(s.createdAt, timeZone, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        }, dateLocale)}
                      </td>
                    </tr>
                  ))}
                </DashboardTable>
              )}
            </DashboardPanel>
          </div>
        ) : null}
      </DashboardPage>
    </>
  );
}
