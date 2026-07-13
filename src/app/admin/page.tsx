import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/auth/admin';
import { getSystemOverview } from '@/lib/admin/overview';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';

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
  const t = await getTranslations('admin');
  const admin = await requireAdmin();
  const timeZone = resolveUserTimeZone(admin);
  const o = await getSystemOverview();
  const deployTotal = Object.values(o.counts.deployments).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6 px-8 py-6">
      <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{t('systemOverview')}</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label={t('users')} value={o.counts.users} />
        <Stat label={t('admins')} value={o.counts.admins} />
        <Stat label={t('suspended')} value={o.counts.suspended} />
        <Stat label={t('new7d')} value={o.counts.newUsers7d} />
        <Stat label={t('workspaces')} value={o.counts.workspaces} />
        <Stat label={t('deployments')} value={deployTotal} />
        <Stat label={t('agents')} value={o.counts.agents} />
        <Stat label={t('toolkits')} value={o.counts.toolkits} />
        <Stat label={t('directoryServers')} value={o.counts.servers} />
        <Stat label={t('directorySkills')} value={o.counts.skills} />
        <Stat label={t('requests24h')} value={o.requests.total} />
        <Stat label={t('errors24h')} value={o.requests.errors} />
        <Stat label={t('p95Ms24h')} value={o.requests.p95Ms} />
        <Stat label={t('installedSkills')} value={o.counts.installedSkills} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('recentSignups')}</h2>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {o.recentUsers.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-zinc-700 dark:text-zinc-300">{u.name ?? u.email}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {u.role === 'admin' ? t('admin') : ''}{u.status === 'suspended' ? t('suspended1') : ''}
                {formatInTimeZone(u.createdAt, timeZone, {
                  year: 'numeric',
                  month: 'numeric',
                  day: 'numeric',
                })}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('scraperJobs')}</h2>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {o.scraper.length === 0 ? (
            <li className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">{t('noScraperRunsRecorded')}</li>
          ) : o.scraper.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="font-mono text-zinc-700 dark:text-zinc-300">{s.job}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {s.doneCount} {t('done')} {formatInTimeZone(s.updatedAt, timeZone, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
