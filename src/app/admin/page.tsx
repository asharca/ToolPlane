import { requireAdmin } from '@/lib/auth/admin';
import { getSystemOverview } from '@/lib/admin/overview';

export const dynamic = 'force-dynamic';

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}

export default async function AdminOverviewPage() {
  await requireAdmin();
  const o = await getSystemOverview();
  const deployTotal = Object.values(o.counts.deployments).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">System overview</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Users" value={o.counts.users} />
        <Stat label="Admins" value={o.counts.admins} />
        <Stat label="Suspended" value={o.counts.suspended} />
        <Stat label="New (7d)" value={o.counts.newUsers7d} />
        <Stat label="Workspaces" value={o.counts.workspaces} />
        <Stat label="Deployments" value={deployTotal} />
        <Stat label="Agents" value={o.counts.agents} />
        <Stat label="Toolkits" value={o.counts.toolkits} />
        <Stat label="Directory servers" value={o.counts.servers} />
        <Stat label="Directory skills" value={o.counts.skills} />
        <Stat label="Requests (24h)" value={o.requests.total} />
        <Stat label="Errors (24h)" value={o.requests.errors} />
        <Stat label="p95 ms (24h)" value={o.requests.p95Ms} />
        <Stat label="Installed skills" value={o.counts.installedSkills} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recent signups</h2>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {o.recentUsers.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-zinc-700 dark:text-zinc-300">{u.name ?? u.email}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {u.role === 'admin' ? 'admin · ' : ''}{u.status === 'suspended' ? 'suspended · ' : ''}
                {new Date(u.createdAt).toLocaleDateString('en-US')}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Scraper jobs</h2>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {o.scraper.length === 0 ? (
            <li className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No scraper runs recorded.</li>
          ) : o.scraper.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="font-mono text-zinc-700 dark:text-zinc-300">{s.job}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {s.doneCount} done · {new Date(s.updatedAt).toLocaleString('en-US')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
