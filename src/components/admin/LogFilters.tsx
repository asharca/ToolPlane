import { useTranslations } from 'next-intl';
import { Button, ButtonLink } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { FormSelect } from '@/components/ui/FormSelect';
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
    : tab === 'a2a' ? ['workspaceId', 'actorId', 'rpcMethod', 'eventName', 'contextId', 'rootTaskId', 'parentTaskId', 'errorType', 'errorCode'] as const
    : ['workspaceId', 'actorId', 'deploymentId', 'agentId', 'model', 'requestId', 'traceId', 'runId', 'channelId', 'eventName', 'errorType', 'errorCode'] as const;
  const activeCount = fields.filter((key) => raw[key]).length + (tab !== 'audit' && raw.level ? 1 : 0);

  return <form action="/admin/logs" className="space-y-3" key={JSON.stringify(raw)}>
    <input type="hidden" name="tab" value={tab} />
    {tab === 'a2a' ? <input type="hidden" name="domain" value="a2a" /> : null}
    {raw.returnTo ? <input type="hidden" name="returnTo" value={raw.returnTo} /> : null}
    {tab !== 'audit' ? <nav aria-label={t('logsQuickFilters')} className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{t('logsQuickFilters')}</span>
      {['error', 'timeout', 'denied'].map((outcome) => {
        const query = new URLSearchParams(Object.entries(raw).filter(([, value]) => value) as Array<[string, string]>);
        query.set('tab', tab);
        if (tab === 'a2a') query.set('domain', 'a2a');
        query.set('outcome', outcome);
        query.delete('cursor');
        query.delete('level');
        return <ButtonLink key={outcome} size="sm" variant={raw.outcome === outcome ? 'primary' : 'secondary'} href={`/admin/logs?${query}`}>{t(`logOutcomes.${outcome}`)}</ButtonLink>;
      })}
    </nav> : null}
    <div className="flex flex-wrap items-end gap-2">
      <Input label={t('logsSearch')} name="q" defaultValue={raw.q} maxLength={200}
        placeholder={t(tab === 'audit' ? 'logsAuditSearchPlaceholder' : 'logsSearchPlaceholder')}
        leftIcon={<Search aria-hidden="true" />} className="min-w-0 basis-full sm:min-w-64 sm:flex-1 sm:basis-0" />
      {tab !== 'audit' ? <>
        {tab !== 'a2a' ? <div className="grid min-w-36 flex-1 gap-1.5 sm:max-w-40">
          <span className="text-xs font-medium">{t('logFields.domain')}</span>
          <FormSelect name="domain" label={t('logFields.domain')} defaultValue={filters.domain ?? 'all'} options={[
            { value: 'all', label: t('logsAll') },
            ...['http', 'mcp', 'a2a', 'agent', 'runtime', 'channel', 'plugin', 'system'].map((value) => ({ value, label: t(`logDomains.${value}`) })),
          ]} />
        </div> : null}
        <div className="grid min-w-32 flex-1 gap-1.5 sm:max-w-36">
          <span className="text-xs font-medium">{t('logsResult')}</span>
          <FormSelect name="outcome" label={t('logsResult')} defaultValue={raw.outcome ?? ''} options={[
            { value: '', label: t('logsAll') },
            ...['success', 'error', 'timeout', 'cancelled', 'denied'].map((value) => ({ value, label: t(`logOutcomes.${value}`) })),
          ]} />
        </div>
      </> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button type="submit"><Search className="size-4" aria-hidden="true" />{t('logsSearch')}</Button>
        <ButtonLink variant="ghost" size="icon" href={`/admin/logs?tab=${tab}`} aria-label={t('logsReset')} title={t('logsReset')}><X className="size-4" aria-hidden="true" /></ButtonLink>
      </div>
    </div>
    {tab === 'a2a' ? <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="grid gap-1.5"><span className="text-xs font-medium">{t('logFields.direction')}</span><FormSelect name="direction" label={t('logFields.direction')} defaultValue={raw.direction ?? ''} options={[{ value: '', label: t('logsAll') }, ...['inbound', 'outbound', 'internal'].map((value) => ({ value, label: t(`logsDirections.${value}`) }))]} /></div>
      {['agentId', 'endpointId', 'clientId', 'taskId', 'requestId', 'traceId'].map((key) => <Input key={key} name={key} label={t(`logFields.${key}`)} defaultValue={raw[key]} maxLength={200} className="min-w-0" />)}
    </div> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label={t('logsTimeRange')} className="flex flex-wrap gap-1">
        {[1, 24, 168].map((hours) => {
          const query = new URLSearchParams(Object.entries(raw).filter(([, value]) => value) as Array<[string, string]>);
          query.set('tab', tab);
          if (tab === 'a2a') query.set('domain', 'a2a');
          query.delete('cursor');
          query.set('since', new Date(observedAt - hours * 3_600_000).toISOString());
          query.set('until', new Date(observedAt).toISOString());
          const current = Math.abs(filters.until.getTime() - filters.since.getTime() - hours * 3_600_000) < 1000
            && Math.abs(filters.until.getTime() - observedAt) < 60_000;
          return <ButtonLink key={hours} size="sm" variant={current ? 'primary' : 'ghost'} aria-current={current ? 'page' : undefined} href={`/admin/logs?${query}`}>{t(`logsRange_${hours}`)}</ButtonLink>;
        })}
      </nav>
      <span className="text-xs text-muted-foreground">{t('logsTimeZone')}</span>
    </div>
    <details open={activeCount > 0} className="group border-b border-border pb-4">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4" aria-hidden="true" />
        {t('logsAdvancedFilters')}
        {activeCount > 0 ? <AnimatedBadge status="neutral">{activeCount}</AnimatedBadge> : null}
        <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="grid min-w-0 gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-4">
        {(['since', 'until'] as const).map((key) => <Input key={key} label={`${t(key === 'since' ? 'logsSince' : 'logsUntil')} (UTC)`}
          type="datetime-local" step="0.001" name={key} className="min-w-0 sm:col-span-2" defaultValue={filters[key].toISOString().slice(0, -1)} />)}
        {fields.map((key) => <Input key={key} label={key === 'targetType' || key === 'targetId' ? ops(key) : t(`logFields.${key}`)}
          name={key} defaultValue={raw[key]} placeholder={key} maxLength={200} className="min-w-0" />)}
        {tab !== 'audit' ? <div className="grid min-w-0 gap-1.5">
          <span className="text-xs font-medium">{t('logFields.level')}</span>
          <FormSelect name="level" label={t('logFields.level')} defaultValue={raw.level ?? ''} options={[
            { value: '', label: t('logsAll') }, ...['debug', 'info', 'warn', 'error'].map((value) => ({ value, label: t(`logLevels.${value}`) })),
          ]} />
        </div> : null}
        <div className="flex items-end"><Button type="submit" variant="secondary"><Search className="size-4" aria-hidden="true" />{t('logsApplyFilters')}</Button></div>
      </div>
    </details>
  </form>;
}
