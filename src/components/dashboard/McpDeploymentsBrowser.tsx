'use client';
import { AnimatedBadge } from '@/components/motion/animated-badge';

import { ButtonLink, Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { Checkbox } from '@/components/motion/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover';
import { FormSelect } from '@/components/ui/FormSelect';


import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, MoreHorizontal, Pause, Play, Plug, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { removeDeploymentsAction, removeDeploymentAction, restartDeploymentAction, startDeploymentsAction, startDeploymentAction, stopDeploymentsAction, stopDeploymentAction } from '@/lib/workspace/actions';
import { DashboardEmptyState, DashboardTable } from './DashboardUI';

export type McpDeploymentListItem = {
  id: string;
  name: string;
  source: string;
  reference: string | null;
  status: string;
  createdAt: string;
  iconUrl: string | null;
};

type FilterStatus = 'all' | 'running' | 'provisioning' | 'error' | 'stopped';

function McpSourceBadge({ source }: { source: string }) {
  const t = useTranslations('console.mcp');
  if (source === 'catalog') return null;
  const knownSource = source === 'custom' || source === 'config' || source === 'docker';

  return (
    <AnimatedBadge  status="neutral" size="sm" showIcon={false}>
      {knownSource ? t(`source.${source}`) : source}
    </AnimatedBadge>
  );
}

function McpDeploymentActions({
  slug,
  deployment,
  compact = false,
}: {
  slug: string;
  deployment: McpDeploymentListItem;
  compact?: boolean;
}) {
  const [t, common] = [useTranslations('console.mcp'), useTranslations('common')];
  const [actionSide, setActionSide] = useState<'top' | 'bottom'>('bottom');
  const isRunning = deployment.status === 'running';
  const isProvisioning = deployment.status === 'provisioning';
  const needsSetup = deployment.status === 'setup_required';
  const base = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
  

  return (
    <div className={`flex items-center justify-end gap-1 ${compact ? 'w-full' : ''}`}>
      {isRunning || isProvisioning ? (
        <form action={stopDeploymentAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="deploymentId" value={deployment.id} />
          <SubmitButton flash={false} pendingLabel={t('stopping')} variant="secondary" size="sm">
            <Pause className="size-3.5" />{t('stop')}
          </SubmitButton>
        </form>
      ) : needsSetup ? (
        <ButtonLink href={`${base}?tab=variables`} variant="secondary" size="sm">
          {t('variables')}
        </ButtonLink>
      ) : (
        <form action={startDeploymentAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="deploymentId" value={deployment.id} />
          <SubmitButton flash={false} pendingLabel={t('starting')} variant="secondary" size="sm">
            <Play className="size-3.5" />{t('start')}
          </SubmitButton>
        </form>
      )}
      <Popover align="end" side={actionSide}>
        <PopoverTrigger>
          <Button type="button" variant="ghost" size="icon" aria-label={`${t('actions')}: ${deployment.name}`} title={t('actions')}
            onClick={(event) => setActionSide(event.currentTarget.getBoundingClientRect().bottom > window.innerHeight / 2 ? 'top' : 'bottom')}>
            <MoreHorizontal className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 max-w-[calc(100vw-2rem)] space-y-1 p-2">
          <ButtonLink href={`${base}?tab=logs`} variant="ghost" size="sm" className="w-full justify-start">
            <FileText className="size-3.5" />{t('logs')}
          </ButtonLink>
          {isRunning ? (
            <form action={restartDeploymentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="deploymentId" value={deployment.id} />
              <SubmitButton flash={false} pendingLabel={t('restarting')} variant="ghost" size="sm" className="w-full justify-start">
                <RotateCcw className="size-3.5" />{t('restart')}
              </SubmitButton>
            </form>
          ) : null}
          <form action={removeDeploymentAction} className="border-t border-border pt-1">
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="deploymentId" value={deployment.id} />
            <ConfirmSubmitButton triggerLabel={<><Trash2 className="size-3.5" />{t('remove')}</>} confirmLabel={common('confirm')} cancelLabel={common('cancel')} prompt={`${t('remove')} ${deployment.name}?`} pendingLabel={`${t('remove')}…`} promptClassName="w-full break-words text-xs text-muted-foreground" className="flex-wrap" triggerClassName="w-full justify-start" triggerVariant="ghost" triggerSize="sm" confirmVariant="secondary" confirmSize="sm" cancelVariant="ghost" cancelSize="sm" />
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function McpBulkDeploymentActions({
  slug,
  deploymentIds,
  onClear,
  className,
}: {
  slug: string;
  deploymentIds: Set<string>;
  onClear: () => void;
  className: string;
}) {
  const [t, common] = [useTranslations('console.mcp'), useTranslations('common')];
  const selection = useTranslations('console.agents');
  const selectedIds = [...deploymentIds];

  return (
    <div
      role="toolbar"
      aria-label={selection('selectedResources', { count: selectedIds.length })}
      className={className}
    >
      <span className="mr-0.5 text-xs font-medium tabular-nums text-accent-foreground" aria-live="polite">
        {selection('selectedResources', { count: selectedIds.length })}
      </span>
      <Button type="button" onClick={onClear} aria-label={selection('clearSelection')} title={selection('clearSelection')} variant="ghost" size="icon" className="flex items-center justify-center"><X className="size-3.5" /></Button>
      <span className="h-4 w-px bg-primary/20" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-1.5">
        <form action={startDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input key={deploymentId} type="hidden" name="deploymentId" value={deploymentId} />
          ))}
          <SubmitButton flash={false} pendingLabel={t('starting')} variant="secondary" size="sm">
            <Play className="size-3.5" />
            {common('start')}
          </SubmitButton>
        </form>
        <form action={stopDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input key={deploymentId} type="hidden" name="deploymentId" value={deploymentId} />
          ))}
          <SubmitButton flash={false} pendingLabel={t('stopping')} variant="secondary" size="sm">
            <Pause className="size-3.5" />
            {common('stop')}
          </SubmitButton>
        </form>
        <form action={removeDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input key={deploymentId} type="hidden" name="deploymentId" value={deploymentId} />
          ))}
          <ConfirmSubmitButton triggerLabel={<><Trash2 className="size-3.5" />{common('delete')}</>} confirmLabel={common('confirm')} cancelLabel={common('cancel')} prompt={`${common('delete')} ${selection('selectedResources', { count: selectedIds.length })}?`} pendingLabel={`${common('delete')}…`} promptClassName="text-xs text-muted-foreground" className="items-center" triggerVariant="secondary" triggerSize="sm" confirmVariant="secondary" confirmSize="sm" cancelVariant="ghost" cancelSize="sm" />
        </form>
      </div>
    </div>
  );
}

function DeploymentIdentity({ deployment }: { deployment: McpDeploymentListItem }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {deployment.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={deployment.iconUrl}
          alt=""
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-md border border-border bg-card object-cover"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
          <Plug className="size-4" />
        </span>
      )}
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-semibold text-foreground">{deployment.name}</span>
          <McpSourceBadge source={deployment.source} />
        </div>
        {deployment.reference ? (
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={deployment.reference}>
            {deployment.reference}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function McpDeploymentsBrowser({
  slug,
  deployments,
}: {
  slug: string;
  deployments: McpDeploymentListItem[];
}) {
  const [t, common] = [useTranslations('console.mcp'), useTranslations('common')];
  const selection = useTranslations('console.agents');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<FilterStatus>('all');
  const [selectedDeploymentIds, setSelectedDeploymentIds] = useState<Set<string>>(() => new Set());
  const counts = useMemo(() => ({
    all: deployments.length,
    running: deployments.filter((deployment) => deployment.status === 'running').length,
    provisioning: deployments.filter((deployment) => deployment.status === 'provisioning').length,
    error: deployments.filter((deployment) => deployment.status === 'error').length,
    stopped: deployments.filter((deployment) => deployment.status === 'stopped').length,
  }), [deployments]);
  const filteredDeployments = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return deployments.filter((deployment) => {
      const matchesStatus = status === 'all' || deployment.status === status;
      if (!matchesStatus) return false;
      if (!term) return true;
      return [deployment.name, deployment.reference, deployment.source]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(term));
    });
  }, [deployments, query, status]);
  const availableDeploymentIds = useMemo(() => new Set(deployments.map((deployment) => deployment.id)), [deployments]);
  const activeSelectedDeploymentIds = useMemo(
    () => new Set([...selectedDeploymentIds].filter((id) => availableDeploymentIds.has(id))),
    [availableDeploymentIds, selectedDeploymentIds],
  );
  const allFilteredSelected = filteredDeployments.length > 0
    && filteredDeployments.every((deployment) => activeSelectedDeploymentIds.has(deployment.id));
  const someFilteredSelected = filteredDeployments.some((deployment) => activeSelectedDeploymentIds.has(deployment.id));


  function toggleDeployment(deploymentId: string, checked: boolean) {
    setSelectedDeploymentIds((current) => {
      const next = new Set([...current].filter((id) => availableDeploymentIds.has(id)));
      if (checked) next.add(deploymentId);
      else next.delete(deploymentId);
      return next;
    });
  }

  function toggleFilteredDeployments() {
    setSelectedDeploymentIds((current) => {
      const next = new Set([...current].filter((id) => availableDeploymentIds.has(id)));
      if (allFilteredSelected) filteredDeployments.forEach((deployment) => next.delete(deployment.id));
      else filteredDeployments.forEach((deployment) => next.add(deployment.id));
      return next;
    });
  }

  const filters: Array<{ key: FilterStatus; label: string; count: number }> = [
    { key: 'all', label: common('all'), count: counts.all },
    { key: 'running', label: t('running'), count: counts.running },
    { key: 'provisioning', label: t('deploying'), count: counts.provisioning },
    { key: 'error', label: t('error'), count: counts.error },
    { key: 'stopped', label: t('stopped'), count: counts.stopped },
  ];

  return (
    <section className="space-y-4" aria-label={t('allMcps')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 sm:max-w-md">
          <Input value={query} onChange={setQuery} placeholder={t('searchMcp')} leftIcon={<Search className="size-4" />} aria-label={t('searchMcp')} rightIcon={query ? <Button type="button" variant="ghost" size="icon" onClick={() => setQuery('')} aria-label={t('clearSearch')}><X className="size-4" /></Button> : undefined} />
        </div>
        <FormSelect
          label={t('status')}
          value={status}
          onValueChange={(value) => setStatus(value as FilterStatus)}
          options={filters.map((filter) => ({ value: filter.key, label: `${filter.label} (${filter.count})` }))}
          className="w-full sm:w-44"
        />
        <p className="text-xs text-muted-foreground sm:ml-auto" aria-live="polite">
          {t('deploymentCountSummary', { count: filteredDeployments.length })}
        </p>
      </div>

      {filteredDeployments.length === 0 ? (
        <DashboardEmptyState
          icon={Search}
          title={t('noMcpFound')}
          description={query || status !== 'all' ? t('searchMcp') : t('noServersDeployedYet')}
          actions={query || status !== 'all' ? (
            <Button type="button" onClick={() => {
              setQuery('');
              setStatus('all');
            }} variant="secondary" size="md">{common('all')}</Button>
          ) : undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 lg:hidden">
            <div className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:border-ring/50 hover:bg-muted">
              <Checkbox checked={allFilteredSelected} onCheckedChange={toggleFilteredDeployments} aria-label={selection('selectMatches', { count: filteredDeployments.length })} indeterminate={someFilteredSelected && !allFilteredSelected} />
              <span className="truncate">{selection('selectMatches', { count: filteredDeployments.length })}</span>
            </div>
            {activeSelectedDeploymentIds.size > 0 ? (
              <McpBulkDeploymentActions
                slug={slug}
                deploymentIds={activeSelectedDeploymentIds}
                onClear={() => setSelectedDeploymentIds(new Set())}
                className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-primary/25 bg-muted px-2.5 py-1.5 sm:w-auto"
              />
            ) : null}
          </div>

          <div className="space-y-3 lg:hidden">
            {filteredDeployments.map((deployment) => {
              const href = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
              const isSelected = activeSelectedDeploymentIds.has(deployment.id);
              return (
                <article key={deployment.id} className={`rounded-xl border border-border bg-card p-4 transition-colors ${isSelected ? 'border-primary/30 bg-muted/30' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <Checkbox checked={isSelected} onCheckedChange={(value) => toggleDeployment(deployment.id, value)} aria-label={selection('selectResource', { name: deployment.name })} />
                    <Link
                      href={href}
                      className="-m-1 min-w-0 flex-1 rounded-md p-1 transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <DeploymentIdentity deployment={deployment} />
                    </Link>
                    <StatusBadge status={deployment.status} />
                  </div>
                  <div className="mt-3 flex items-center justify-end">
                    <McpDeploymentActions slug={slug} deployment={deployment} compact />
                  </div>
                </article>
              );
            })}
          </div>

          <div className="hidden space-y-3 lg:block">{activeSelectedDeploymentIds.size > 0 ? (
                  <McpBulkDeploymentActions
                    slug={slug}
                    deploymentIds={activeSelectedDeploymentIds}
                    onClear={() => setSelectedDeploymentIds(new Set())}
                    className="flex flex-wrap items-center gap-1.5"
                  />
                ) : null}<DashboardTable minWidth="36rem" ariaLabel={t('allMcps')} headers={[
                {
                  label: (
                    <Checkbox checked={allFilteredSelected} onCheckedChange={toggleFilteredDeployments} aria-label={selection('selectMatches', { count: filteredDeployments.length })} indeterminate={someFilteredSelected && !allFilteredSelected} />
                  ),
                  width: '3rem',
                },
                { label: t('serverColumn') },
                { label: t('status') },
                { label: t('actions'), align: 'right' },
              ]} rows={filteredDeployments.map((deployment) => {
              const href = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
              const isSelected = activeSelectedDeploymentIds.has(deployment.id);
              return (
                {id: deployment.id, cells: [<><Checkbox checked={isSelected} onCheckedChange={(value) => toggleDeployment(deployment.id, value)} aria-label={selection('selectResource', { name: deployment.name })} /></>,
<><Link
                      href={href}
                      className="block px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      <DeploymentIdentity deployment={deployment} />
                    </Link></>,
<><StatusBadge status={deployment.status} /></>,
<><McpDeploymentActions slug={slug} deployment={deployment} /></>]}
              );
            })} /></div>
        </>
      )}
    </section>
  );
}
