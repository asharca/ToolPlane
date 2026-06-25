import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getObservability } from '@/lib/observability/log';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { TabBar } from '@/components/dashboard/TabBar';

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
    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          {value}
        </span>
        {unit ? (
          <span className="text-sm text-zinc-400">{unit}</span>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>
    </div>
  );
}

const TABS = [
  { key: 'usage', label: 'Usage' },
  { key: 'audit', label: 'Audit log' },
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
  const max = Math.max(1, ...o.series.map((s) => s.total));
  const errorRate = o.total ? (Math.round((o.errors / o.total) * 1000) / 10) : 0;
  const base = `/app/${slug}/observability`;

  return (
    <>
      <DashboardHeader title="Observability" />
      <div className="space-y-6 px-8 py-6">
        <TabBar tabs={TABS} current={current} basePath={base} />

        <p className="text-sm text-zinc-500 dark:text-zinc-400">
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

            <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Requests per hour
                </h3>
                <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
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
                <p className="py-12 text-center text-sm text-zinc-400">
                  No traffic yet. Call a deployment&apos;s gateway endpoint to see
                  activity here.
                </p>
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
                        <span className="mt-1 text-[9px] text-zinc-400">
                          {s.hour}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            {o.recent.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-400">
                No requests logged in the last 24 hours.
              </p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Method</th>
                    <th className="px-4 py-3 font-medium">Path</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Duration</th>
                    <th className="px-4 py-3 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {o.recent.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                        {l.method}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-300">
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
                      <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-400">
                        {l.durationMs}ms
                      </td>
                      <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-400">
                        {l.createdAt.toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </>
  );
}
