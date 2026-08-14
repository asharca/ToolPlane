'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowUpRight,
  Pause,
  Play,
  Plug,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  removeDeploymentAction,
  restartDeploymentAction,
  startDeploymentAction,
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
      <Link href={base} className={compact ? 'ui-button-secondary h-8 px-2.5 text-xs' : textAction}>
        {compact ? <ArrowUpRight className="size-3.5" /> : null}
        {t('inspect')}
      </Link>
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
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<FilterStatus>('all');
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
          <div className="space-y-3 lg:hidden">
            {filteredDeployments.map((deployment) => (
              <article key={deployment.id} className="ui-panel p-4">
                <div className="flex items-start justify-between gap-3">
                  <DeploymentIdentity deployment={deployment} />
                  <StatusBadge status={deployment.status} />
                </div>
                <div className="mt-4 space-y-2 border-t border-border pt-3">
                  <span className="text-xs text-muted-foreground">{deployment.createdAt}</span>
                  <McpDeploymentActions slug={slug} deployment={deployment} compact />
                </div>
              </article>
            ))}
          </div>

          <DashboardTable
            minWidth="54rem"
            className="hidden lg:block"
            ariaLabel={t('allMcps')}
            headers={[
              { label: t('serverColumn') },
              { label: t('status') },
              { label: t('created') },
              { label: t('actions'), align: 'right' },
            ]}
          >
            {filteredDeployments.map((deployment) => (
              <tr key={deployment.id}>
                <td className="px-4 py-3">
                  <DeploymentIdentity deployment={deployment} />
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
            ))}
          </DashboardTable>
        </>
      )}
    </section>
  );
}
