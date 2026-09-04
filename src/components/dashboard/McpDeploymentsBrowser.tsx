'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Pause,
  Play,
  Plug,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  removeDeploymentsAction,
  removeDeploymentAction,
  restartDeploymentAction,
  startDeploymentsAction,
  startDeploymentAction,
  stopDeploymentsAction,
  stopDeploymentAction,
} from '@/lib/workspace/actions';
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

const textAction =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

const lifecycleAction =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:border-ring/50 hover:bg-accent hover:text-accent-foreground';

function McpSourceBadge({ source }: { source: string }) {
  const t = useTranslations('console.mcp');
  if (source === 'catalog') return null;
  const knownSource = source === 'custom' || source === 'config' || source === 'docker';

  return (
    <span className="inline-flex items-center rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {knownSource ? t(`source.${source}`) : source}
    </span>
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
  const isRunning = deployment.status === 'running';
  const isProvisioning = deployment.status === 'provisioning';
  const needsSetup = deployment.status === 'setup_required';
  const base = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
  const actionClass = compact ? lifecycleAction : textAction;

  return (
    <div className={`flex flex-wrap items-center gap-1 ${compact ? 'w-full' : 'justify-end'}`}>
      <Link href={`${base}?tab=logs`} className={textAction}>
        {t('logs')}
      </Link>
      {isRunning || isProvisioning ? (
        <>
          <form action={stopDeploymentAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="deploymentId" value={deployment.id} />
            <SubmitButton flash={false} pendingLabel={t('stopping')} className={actionClass}>
              {compact ? <Pause className="size-3.5" /> : null}
              {t('stop')}
            </SubmitButton>
          </form>
          {isRunning ? (
            <form action={restartDeploymentAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="deploymentId" value={deployment.id} />
              <SubmitButton flash={false} pendingLabel={t('restarting')} className={actionClass}>
                {compact ? <RotateCcw className="size-3.5" /> : null}
                {t('restart')}
              </SubmitButton>
            </form>
          ) : null}
        </>
      ) : needsSetup ? (
        <Link href={`${base}?tab=variables`} className={actionClass}>
          {t('variables')}
        </Link>
      ) : (
        <form action={startDeploymentAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="deploymentId" value={deployment.id} />
          <SubmitButton flash={false} pendingLabel={t('starting')} className={actionClass}>
            {compact ? <Play className="size-3.5" /> : null}
            {t('start')}
          </SubmitButton>
        </form>
      )}
      <form action={removeDeploymentAction}>
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="deploymentId" value={deployment.id} />
        <ConfirmSubmitButton
          triggerLabel={t('remove')}
          confirmLabel={common('confirm')}
          cancelLabel={common('cancel')}
          prompt={`${t('remove')} ${deployment.name}?`}
          pendingLabel={`${t('remove')}…`}
          className={compact ? 'items-center' : 'items-center justify-end'}
          triggerClassName={`${textAction} hover:text-red-600 dark:hover:text-red-400`}
          confirmClassName="h-8 rounded-md px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          cancelClassName={textAction}
          promptClassName="max-w-40 truncate text-xs text-muted-foreground"
        />
      </form>
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
      <button
        type="button"
        onClick={onClear}
        aria-label={selection('clearSelection')}
        title={selection('clearSelection')}
        className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <span className="h-4 w-px bg-brand/20" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-1.5">
        <form action={startDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input key={deploymentId} type="hidden" name="deploymentId" value={deploymentId} />
          ))}
          <SubmitButton flash={false} pendingLabel={t('starting')} className={lifecycleAction}>
            <Play className="size-3.5" />
            {common('start')}
          </SubmitButton>
        </form>
        <form action={stopDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input key={deploymentId} type="hidden" name="deploymentId" value={deploymentId} />
          ))}
          <SubmitButton flash={false} pendingLabel={t('stopping')} className={lifecycleAction}>
            <Pause className="size-3.5" />
            {common('stop')}
          </SubmitButton>
        </form>
        <form action={removeDeploymentsAction}>
          <input type="hidden" name="workspace" value={slug} />
          {selectedIds.map((deploymentId) => (
            <input key={deploymentId} type="hidden" name="deploymentId" value={deploymentId} />
          ))}
          <ConfirmSubmitButton
            triggerLabel={<><Trash2 className="size-3.5" />{common('delete')}</>}
            confirmLabel={common('confirm')}
            cancelLabel={common('cancel')}
            prompt={`${common('delete')} ${selection('selectedResources', { count: selectedIds.length })}?`}
            pendingLabel={`${common('delete')}…`}
            className="items-center"
            triggerClassName={`${lifecycleAction} hover:border-red-500/30 hover:text-red-600 dark:hover:text-red-400`}
            confirmClassName="h-8 rounded-md px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            cancelClassName={textAction}
            promptClassName="text-xs text-muted-foreground"
          />
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
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
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
  const mobileSelectAllRef = useRef<HTMLInputElement>(null);
  const desktopSelectAllRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    for (const selectAllRef of [mobileSelectAllRef, desktopSelectAllRef]) {
      if (selectAllRef.current) {
        selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
      }
    }
  }, [allFilteredSelected, someFilteredSelected]);

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
      <div className="ui-panel p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="relative block min-w-0 lg:max-w-md lg:flex-1">
            <span className="sr-only">{t('searchMcp')}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchMcp')}
              className="ui-input ui-input-icon h-10 w-full pr-9"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={common('all')}
              >
                <X className="size-4" />
              </button>
            ) : null}
          </label>
          <div className="flex flex-wrap gap-1.5" aria-label={t('status')}>
            {filters.map((filter) => {
              const active = status === filter.key;
              return (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => setStatus(filter.key)}
                  aria-pressed={active}
                  aria-label={`${filter.label} (${filter.count})`}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
                    active
                      ? 'border-brand/30 bg-brand-soft text-brand'
                      : 'border-border bg-card text-muted-foreground hover:border-ring/50 hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {filter.label}
                  <span className="text-[10px] opacity-70">{filter.count}</span>
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t('deploymentCountSummary', { count: filteredDeployments.length })}
        </p>
      </div>

      {filteredDeployments.length === 0 ? (
        <DashboardEmptyState
          icon={Search}
          title={t('noMcpFound')}
          description={query || status !== 'all' ? t('searchMcp') : t('noServersDeployedYet')}
          actions={query || status !== 'all' ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setStatus('all');
              }}
              className="ui-button-secondary"
            >
              {common('all')}
            </button>
          ) : undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 lg:hidden">
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:border-ring/50 hover:bg-muted">
              <input
                ref={mobileSelectAllRef}
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleFilteredDeployments}
                aria-label={selection('selectMatches', { count: filteredDeployments.length })}
                className="size-4 accent-brand"
              />
              <span className="truncate">{selection('selectMatches', { count: filteredDeployments.length })}</span>
            </label>
            {activeSelectedDeploymentIds.size > 0 ? (
              <McpBulkDeploymentActions
                slug={slug}
                deploymentIds={activeSelectedDeploymentIds}
                onClear={() => setSelectedDeploymentIds(new Set())}
                className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-brand/25 bg-brand-soft px-2.5 py-1.5 sm:w-auto"
              />
            ) : null}
          </div>

          <div className="space-y-3 lg:hidden">
            {filteredDeployments.map((deployment) => {
              const href = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
              const isSelected = activeSelectedDeploymentIds.has(deployment.id);
              return (
                <article key={deployment.id} className={`ui-panel p-4 transition-colors ${isSelected ? 'border-brand/30 bg-brand-soft/30' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(event) => toggleDeployment(deployment.id, event.target.checked)}
                      aria-label={selection('selectResource', { name: deployment.name })}
                      className="mt-2 size-4 shrink-0 accent-brand"
                    />
                    <Link
                      href={href}
                      className="-m-1 min-w-0 flex-1 rounded-md p-1 transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <DeploymentIdentity deployment={deployment} />
                    </Link>
                    <StatusBadge status={deployment.status} />
                  </div>
                  <div className="mt-4 space-y-2 border-t border-border pt-3">
                    <span className="text-xs text-muted-foreground">{deployment.createdAt}</span>
                    <McpDeploymentActions slug={slug} deployment={deployment} compact />
                  </div>
                </article>
              );
            })}
          </div>

          <DashboardTable
            minWidth="54rem"
            className="hidden lg:block"
            ariaLabel={t('allMcps')}
            headers={activeSelectedDeploymentIds.size > 0
              ? [{
                label: (
                  <McpBulkDeploymentActions
                    slug={slug}
                    deploymentIds={activeSelectedDeploymentIds}
                    onClear={() => setSelectedDeploymentIds(new Set())}
                    className="flex flex-wrap items-center gap-1.5"
                  />
                ),
                colSpan: 5,
                className: 'bg-brand-soft/50 text-left',
              }]
              : [
                {
                  label: (
                    <input
                      ref={desktopSelectAllRef}
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleFilteredDeployments}
                      aria-label={selection('selectMatches', { count: filteredDeployments.length })}
                      className="size-4 accent-brand"
                    />
                  ),
                  className: 'w-12',
                },
                { label: t('serverColumn') },
                { label: t('status') },
                { label: t('created') },
                { label: t('actions'), align: 'right' },
              ]}
          >
            {filteredDeployments.map((deployment) => {
              const href = `/app/${encodeURIComponent(slug)}/mcp/${deployment.id}`;
              const isSelected = activeSelectedDeploymentIds.has(deployment.id);
              return (
                <tr key={deployment.id} className={isSelected ? 'bg-brand-soft/30' : undefined}>
                  <td className="w-12 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(event) => toggleDeployment(deployment.id, event.target.checked)}
                      aria-label={selection('selectResource', { name: deployment.name })}
                      className="size-4 accent-brand"
                    />
                  </td>
                  <td className="p-0">
                    <Link
                      href={href}
                      className="block px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      <DeploymentIdentity deployment={deployment} />
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={deployment.status} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-muted-foreground">
                    {deployment.createdAt}
                  </td>
                  <td className="px-4 py-3">
                    <McpDeploymentActions slug={slug} deployment={deployment} />
                  </td>
                </tr>
              );
            })}
          </DashboardTable>
        </>
      )}
    </section>
  );
}
