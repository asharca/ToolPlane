import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Activity, Server, CircleAlert } from 'lucide-react';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';
import { LogTimestamp } from '@/components/admin/LogUI';
import { getLogHealth } from '@/lib/observability/health';

export async function LogHealth({ adminId }: { adminId: string }) {
  const t = await getTranslations('admin');
  const health = await getLogHealth(adminId);
  const href = (values: Record<string, string>) => `/admin/logs?${new URLSearchParams({
    tab: 'all', since: health.since.toISOString(), until: health.until.toISOString(), ...values,
  })}`;
  const alerts = health.domains.reduce((count, row) => count + row.errors, 0) + health.abnormal.length + health.writer.failures + health.writer.dropped;
  return <details className="group border-t border-border pt-4"><summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold"><Activity className="size-4" />{t('logsHealthTitle')}{alerts ? <AdminBadge tone="warning">{t('logsHealthAlerts', { count: alerts })}</AdminBadge> : null}</summary><AdminPanel title={t('logsHealthTitle')}
    description={t('logsHealthScope')} actions={<AdminBadge tone={health.state === 'attention' ? 'warning' : 'neutral'}>{t(`logsHealth_${health.state}`)}</AdminBadge>}>
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('logsHealthUpdated')} <LogTimestamp date={health.until} /></p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {['http', 'mcp', 'a2a', 'agent', 'runtime', 'channel', 'plugin', 'system'].map((domain) => {
          const row = health.domains.find((item) => item.domain === domain);
          return <Link key={domain} href={href({ domain })} className="min-w-0 space-y-3 rounded-lg border border-border p-4 transition-colors hover:bg-muted/40">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{t(`logDomains.${domain}`)}</span>
              <AdminBadge tone={row?.errors ? 'danger' : 'neutral'}>{t(row?.errors ? 'logsHealth_attention' : row ? 'logsHealth_observed' : 'logsHealth_unknown')}</AdminBadge></div>
            <p className={`text-2xl font-semibold tabular-nums ${row?.errors ? 'text-destructive' : ''}`}>{row ? row.errors : '—'} <span className="text-xs font-normal text-muted-foreground">{t('logsHealthErrors')}</span></p>
            <p className="text-xs text-muted-foreground">{t('logsHealthCounts', { total: row?.total ?? 0, denied: row?.denied ?? 0 })}</p>
            {row ? <p className="text-xs text-muted-foreground">{t('logsHealthLast')} <LogTimestamp date={row.last} compact /></p> : null}
          </Link>;
        })}
        <div className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium"><Server className="size-4" />{t('logsHealthDeployments')}</h3>
          <p className={health.abnormal.length ? 'text-2xl font-semibold text-destructive' : 'text-2xl font-semibold'}>{health.abnormal.length} / {health.deploymentCount}</p>
          <p className="text-xs text-muted-foreground">{t('logsHealthDeploymentNote')}</p>
        </div>
      </div>
      {health.abnormal.length ? <div className="rounded-lg border border-destructive/30 p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><CircleAlert className="size-4 text-destructive" />{t('logsHealthAbnormal')}</h3>
        <ul className="grid gap-2 sm:grid-cols-2">{health.abnormal.slice(0, 8).map((row) => <li key={row.id}>
          <Link href={`/admin/logs?${new URLSearchParams({ tab: 'all', deploymentId: row.id })}`} className="flex min-w-0 items-center justify-between gap-3 text-sm hover:underline"><span className="truncate">{row.name}</span><AdminBadge tone="danger">{row.status}</AdminBadge></Link>
        </li>)}</ul>
        <Link href="/admin" className="mt-3 inline-block text-xs text-primary hover:underline">{t('logsHealthAllDeployments')}</Link>
      </div> : null}
      <p role="status" className={`text-xs ${health.writer.failures || health.writer.dropped ? 'text-destructive' : 'text-muted-foreground'}`}>
        {t('logsHealthWriter', health.writer)}
      </p>
    </div>
  </AdminPanel></details>;
}
