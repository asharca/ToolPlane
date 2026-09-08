import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button, Input, Tab, TabList } from '@asharca/ui';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import type { LogFilters as Filters } from '@/lib/observability/queries';

export function LogFilters({ tab, raw, filters, observedAt }: {
  tab: string;
  raw: Record<string, string | undefined>;
  filters: Filters;
  observedAt: number;
}) {
  const t = useTranslations('admin');
  const ops = useTranslations('adminOps');
  const fields = tab === 'audit' ? ['workspaceId', 'actorId', 'requestId', 'traceId', 'targetType', 'targetId'] as const
    : ['workspaceId', 'actorId', 'deploymentId', 'agentId', 'model', 'requestId', 'traceId', 'runId', 'channelId', 'eventName', 'errorType', 'errorCode'] as const;
  const activeCount = fields.filter((key) => raw[key]).length + (tab !== 'audit' && raw.level ? 1 : 0);

  return <form action="/admin/logs" className="space-y-3" key={JSON.stringify(raw)}>
    <input type="hidden" name="tab" value={tab} />
    {raw.returnTo ? <input type="hidden" name="returnTo" value={raw.returnTo} /> : null}
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid min-w-0 basis-full gap-1.5 text-xs font-medium sm:min-w-64 sm:flex-1 sm:basis-0">
        {t('logsSearch')}
        <span className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={raw.q} maxLength={200} placeholder={t(tab === 'audit' ? 'logsAuditSearchPlaceholder' : 'logsSearchPlaceholder')} className="ui-input-icon h-10 w-full" />
        </span>
      </label>
      {tab !== 'audit' ? <>
        <label className="grid min-w-36 flex-1 gap-1.5 text-xs font-medium sm:max-w-40">
          {t('logFields.domain')}
          <select name="domain" className="ui-input h-10 w-full text-xs" defaultValue={filters.domain ?? 'all'}>
            <option value="all">{t('logsAll')}</option>
            {['http', 'mcp', 'agent', 'runtime', 'channel', 'plugin', 'system'].map((value) => <option key={value} value={value}>{t(`logDomains.${value}`)}</option>)}
          </select>
        </label>
        <label className="grid min-w-32 flex-1 gap-1.5 text-xs font-medium sm:max-w-36">
          {t('logsResult')}
          <select name="outcome" className="ui-input h-10 w-full text-xs" defaultValue={raw.outcome ?? ''}>
            <option value="">{t('logsAll')}</option>
            {['success', 'error', 'timeout', 'cancelled', 'denied'].map((value) => <option key={value} value={value}>{t(`logOutcomes.${value}`)}</option>)}
          </select>
        </label>
      </> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button type="submit" variant="primary" className="h-10"><Search className="size-4" aria-hidden="true" />{t('logsSearch')}</Button>
        <Link className="ui-button-ghost ui-icon-button h-10" href={`/admin/logs?tab=${tab}`} aria-label={t('logsReset')} title={t('logsReset')}><X className="size-4" aria-hidden="true" /></Link>
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <TabList navigation label={t('logsTimeRange')} className="rounded-md">
        {[1, 24, 168].map((hours) => {
          const query = new URLSearchParams(Object.entries(raw).filter(([, value]) => value) as Array<[string, string]>);
          query.set('tab', tab);
          query.delete('cursor');
          query.set('since', new Date(observedAt - hours * 3_600_000).toISOString());
          query.set('until', new Date(observedAt).toISOString());
          const current = Math.abs(filters.until.getTime() - filters.since.getTime() - hours * 3_600_000) < 1000
            && Math.abs(filters.until.getTime() - observedAt) < 60_000;
          return <Tab key={hours} asChild navigation current={current} className="min-h-9 rounded px-3 text-xs">
            <Link href={`/admin/logs?${query}`}>{t(`logsRange_${hours}`)}</Link>
          </Tab>;
        })}
      </TabList>
      <span className="text-xs text-muted-foreground">{t('logsTimeZone')}</span>
    </div>
    <details open={activeCount > 0} className="group border-b border-border pb-4">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4" aria-hidden="true" />
        {t('logsAdvancedFilters')}
        {activeCount > 0 ? <span className="rounded bg-brand-soft px-1.5 py-0.5 tabular-nums text-foreground">{activeCount}</span> : null}
        <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="grid min-w-0 gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-4">
        {(['since', 'until'] as const).map((key) => <label key={key} className="grid min-w-0 gap-1.5 text-xs font-medium sm:col-span-2">
          {t(key === 'since' ? 'logsSince' : 'logsUntil')} (UTC)
          <input type="datetime-local" step="0.001" name={key} className="ui-input h-10 min-w-0 w-full" defaultValue={filters[key].toISOString().slice(0, -1)} />
        </label>)}
        {fields.map((key) => <label key={key} className="grid min-w-0 gap-1.5 text-xs font-medium">
          {key === 'targetType' || key === 'targetId' ? ops(key) : t(`logFields.${key}`)}
          <Input name={key} defaultValue={raw[key]} placeholder={key} maxLength={200} className="h-10 w-full font-mono text-xs" />
        </label>)}
        {tab !== 'audit' ? <label className="grid min-w-0 gap-1.5 text-xs font-medium">
          {t('logFields.level')}
          <select name="level" className="ui-input h-10 w-full" defaultValue={raw.level ?? ''}>
            <option value="">{t('logsAll')}</option>
            {['debug', 'info', 'warn', 'error'].map((value) => <option key={value} value={value}>{t(`logLevels.${value}`)}</option>)}
          </select>
        </label> : null}
        <div className="flex items-end"><Button type="submit" variant="secondary" className="h-10"><Search className="size-4" aria-hidden="true" />{t('logsApplyFilters')}</Button></div>
      </div>
    </details>
  </form>;
}
