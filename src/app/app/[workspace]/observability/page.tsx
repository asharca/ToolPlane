import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getObservability } from '@/lib/observability/log';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

export const dynamic = 'force-dynamic';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-5">
      <div className="text-xs uppercase tracking-wide text-zinc-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-zinc-900">{value}</div>
    </div>
  );
}

export default async function ObservabilityPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const o = await getObservability(ws.id);
  const max = Math.max(1, ...o.series.map((s) => s.total));
  const errorRate = o.total ? Math.round((o.errors / o.total) * 100) : 0;

  return (
    <>
      <DashboardHeader title="Observability" />
      <div className="space-y-6 px-8 py-6">
        <p className="text-sm text-zinc-500">
          Gateway request activity over the last 24 hours.
        </p>

        <div className="grid grid-cols-3 gap-4">
          <Stat label="Requests" value={o.total} />
          <Stat label="Error rate" value={`${errorRate}%`} />
          <Stat label="Avg latency" value={`${o.avgMs}ms`} />
        </div>

        <div className="rounded-lg border border-zinc-200 p-5">
          <h3 className="mb-4 text-sm font-semibold text-zinc-900">
            Requests per hour
          </h3>
          {o.total === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-400">
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
                        className="w-full rounded-t-sm bg-zinc-300"
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

        {o.recent.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-zinc-200">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Method</th>
                  <th className="px-4 py-3 font-medium">Path</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {o.recent.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">
                      {l.method}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">
                      {l.path}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          l.statusCode >= 400
                            ? 'text-red-600'
                            : 'text-emerald-600'
                        }
                      >
                        {l.statusCode}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500">{l.durationMs}ms</td>
                    <td className="px-4 py-2.5 text-zinc-500">
                      {l.createdAt.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}
