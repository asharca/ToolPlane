import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/admin';
import { getSystemOverview } from '@/lib/admin/overview';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { AdminBadge, AdminPage, AdminPageHeader, AdminPanel } from '@/components/admin/AdminUI';

export const dynamic = 'force-dynamic';

function Metric({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: number | string;
  note: React.ReactNode;
  href?: string;
}) {
  const content = (
    <>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <strong className="mt-2 block text-3xl font-bold tabular-nums text-foreground">{value}</strong>
      <span className="mt-2 block text-xs text-muted-foreground group-hover:text-foreground">{note}</span>
    </>
  );

  return href ? (
    <Link
      href={href}
      className="group min-w-0 bg-card px-5 py-5 transition-colors hover:bg-accent/35 sm:px-6"
    >
      {content}
    </Link>
  ) : (
    <div className="min-w-0 bg-card px-5 py-5 sm:px-6">{content}</div>
  );
}

function InventoryGroup({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; value: number }>;
}) {
  return (
    <div className="px-5 py-4">
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
  const deployTotal = Object.values(o.counts.deployments).reduce((a, b) => a + b, 0);
  const hasRequestData = o.requests.total > 0;
  const errorRate = hasRequestData ? (o.requests.errors / o.requests.total) * 100 : null;

  return (
    <AdminPage>
      <AdminPageHeader title={t('systemOverview')} description={t('overviewDescription')} />

      <section className="ui-panel grid gap-px overflow-hidden bg-border sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label={t('users')}
          value={o.counts.users.toLocaleString()}
          href="/admin/users"
          note={t('userAccountSummary', {
            admins: o.counts.admins.toLocaleString(),
            suspended: o.counts.suspended.toLocaleString(),
            newUsers: o.counts.newUsers7d.toLocaleString(),
          })}
        />
        <Metric
          label={t('workspaces')}
          value={o.counts.workspaces.toLocaleString()}
          href="/admin/workspaces"
          note={t('workspaceMemberships', { count: o.counts.memberships.toLocaleString() })}
        />
        <Metric
          label={t('deployments')}
          value={deployTotal.toLocaleString()}
          href="/admin/workspaces"
          note={t('configuredAgents', { count: o.counts.agents.toLocaleString() })}
        />
        <Metric
          label={t('requests24h')}
          value={o.requests.total.toLocaleString()}
          note={t('errorsInWindow', { count: o.requests.errors.toLocaleString() })}
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,.65fr)]">
        <AdminPanel
          title={t('requestHealth')}
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
                className={`px-5 py-6 ${index > 0 ? 'border-t border-border sm:border-l sm:border-t-0' : ''}`}
              >
                <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
                <dd className="mt-3 text-2xl font-bold tabular-nums text-foreground">{item.value}</dd>
                <dd className="mt-1 text-xs text-muted-foreground">{item.note}</dd>
              </div>
            ))}
          </dl>
        </AdminPanel>

        <AdminPanel title={t('resourceInventory')} description={t('currentTotals')} padded={false}>
          <div className="grid sm:grid-cols-2 xl:grid-cols-2 [&>*+*]:border-t [&>*+*]:border-border sm:[&>*+*]:border-l sm:[&>*+*]:border-t-0">
            <InventoryGroup
              title={t('runtime')}
              items={[
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
                { label: t('clients'), value: o.counts.clients },
                { label: t('categories'), value: o.counts.categories },
              ]}
            />
          </div>
        </AdminPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,.75fr)]">
        <AdminPanel
          title={t('recentSignups')}
          description={t('latestAccounts', { count: o.recentUsers.length })}
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
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{u.name ?? u.email}</span>
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

        <AdminPanel
          title={t('scraperJobs')}
          description={t('sourceCount', { count: o.scraper.length })}
          padded={false}
        >
          {o.scraper.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">{t('noScraperRunsRecorded')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {o.scraper.map((s) => (
                <li key={s.id} className="px-5 py-4">
                  <p className="break-words font-mono text-xs text-foreground">{s.job}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('itemsCompleted', { count: s.doneCount })} ·{' '}
                    {formatInTimeZone(s.updatedAt, timeZone, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }, locale)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>
      </div>
    </AdminPage>
  );
}
