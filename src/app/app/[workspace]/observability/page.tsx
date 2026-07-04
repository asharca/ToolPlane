import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getObservability } from '@/lib/observability/log';
import { getPluginTelemetry } from '@/lib/observability/plugin-telemetry';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { TabBar } from '@/components/dashboard/TabBar';
import {
  DashboardEmptyState,
  DashboardPage,
  DashboardPanel,
  DashboardTable,
} from '@/components/dashboard/DashboardUI';

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

const TABS = [
  { key: 'usage', label: 'Usage' },
  { key: 'audit', label: 'Audit log' },
  { key: 'plugin', label: 'Plugin' },
];

export default async function ObservabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspace: slug } = await params;
  const { tab } = await searchParams;
  const current = TABS.some((t) => t.key === tab) ? tab! : 'usage';

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const o = await getObservability(ws.id);
  const pt = current === 'plugin' ? await getPluginTelemetry(ws.id) : null;
  const max = Math.max(1, ...o.series.map((s) => s.total));
  const errorRate = o.total ? (Math.round((o.errors / o.total) * 1000) / 10) : 0;
  const base = `/app/${slug}/observability`;

  return (
    <>
      <DashboardHeader title="Observability" />
      <DashboardPage>
        <TabBar tabs={TABS} current={current} basePath={base} />

        <p className="text-sm text-muted-foreground">
          Tool calls, latency, and errors across every server. Aggregated over
          the last 24 hours.
        </p>

        {current === 'usage' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Total requests · 24h"
                value={compact(o.total)}
                sub="tool calls received"
              />
              <Stat
                label="Error rate"
                value={errorRate}
                unit="%"
                sub={`${o.errors} error${o.errors === 1 ? '' : 's'}`}
              />
              <Stat
                label="Avg latency"
                value={o.avgMs}
                unit="ms"
                sub="average response"
              />
              <Stat
                label="P95 latency"
                value={o.p95Ms}
                unit="ms"
                sub="95th percentile"
              />
            </div>

            <DashboardPanel title="Requests per hour">
              <div className="mb-4 flex items-center justify-between">
                <div />
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-sky-500" />
                    requests
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-red-400" />
                    errors
                  </span>
                </div>
              </div>
              {o.total === 0 ? (
                <DashboardEmptyState
                  description="No traffic yet. Call a deployment's gateway endpoint to see activity here."
                  className="min-h-48"
                />
              ) : (
                <div className="flex h-40 items-end gap-1">
                  {o.series.map((s, i) => {
                    const ok = s.total - s.errors;
                    return (
                      <div
                        key={i}
                        className="flex flex-1 flex-col items-center justify-end"
                        title={`${s.hour}: ${s.total} reqs, ${s.errors} errors`}
                      >
                        <div
                          className="flex w-full flex-col justify-end"
                          style={{ height: `${(s.total / max) * 100}%` }}
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
                        <span className="mt-1 text-[9px] text-muted-foreground">
                          {s.hour}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </DashboardPanel>
          </>
        ) : current === 'audit' ? (
          <DashboardPanel title="Audit log" padded={false}>
            {o.recent.length === 0 ? (
              <DashboardEmptyState
                description="No requests logged in the last 24 hours."
                className="min-h-48 rounded-none border-0"
              />
            ) : (
              <DashboardTable
                panel={false}
                headers={[
                  { label: 'Method' },
                  { label: 'Path' },
                  { label: 'Status' },
                  { label: 'Duration' },
                  { label: 'Time' },
                ]}
              >
                {o.recent.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground">
                      {l.method}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground">
                      {l.path}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          l.statusCode >= 400
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }
                      >
                        {l.statusCode}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {l.durationMs}ms
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {l.createdAt.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                ))}
              </DashboardTable>
            )}
          </DashboardPanel>
        ) : pt ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Skill calls · 24h"
                value={compact(pt.skill.total)}
                sub="across installed plugins"
              />
              <Stat
                label="User / agent"
                value={`${pt.skill.byUser} / ${pt.skill.byAgent}`}
                sub="slash vs. autonomous"
              />
              <Stat
                label="Skill errors"
                value={pt.skill.errors}
                sub="failed invocations"
              />
              <Stat
                label="Skill syncs"
                value={pt.sync.applied}
                sub={`${pt.sync.failures} failed`}
              />
            </div>

            <DashboardPanel title="Recent skill invocations" padded={false}>
              {pt.skill.recent.length === 0 ? (
                <DashboardEmptyState
                  description="No skill invocations yet. Install a toolkit as an auto-sync plugin and run one of its skills."
                  className="min-h-48 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  panel={false}
                  headers={[
                    { label: 'Skill' },
                    { label: 'Source' },
                    { label: 'Outcome' },
                    { label: 'Time' },
                  ]}
                >
                  {pt.skill.recent.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-2.5 font-mono text-xs text-foreground">
                        {s.skillSlug}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {s.source}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={
                            s.outcome === 'error'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {s.outcome}
                          {s.errorClass ? ` · ${s.errorClass}` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {s.createdAt.toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  ))}
                </DashboardTable>
              )}
            </DashboardPanel>

            <DashboardPanel title="Recent skill syncs" padded={false}>
              {pt.sync.recent.length === 0 ? (
                <DashboardEmptyState
                  description="No syncs recorded yet."
                  className="min-h-48 rounded-none border-0"
                />
              ) : (
                <DashboardTable
                  panel={false}
                  headers={[
                    { label: 'Outcome' },
                    { label: 'Added' },
                    { label: 'Updated' },
                    { label: 'Removed' },
                    { label: 'Time' },
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
                            ? `failure${s.reason ? ` · ${s.reason}` : ''}`
                            : 'applied'}
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
                        {s.createdAt.toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
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
