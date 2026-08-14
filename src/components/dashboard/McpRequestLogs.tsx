'use client';

import type { ComponentType } from 'react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  Activity,
  Braces,
  ChevronDown,
  CircleAlert,
  Clock3,
  HeartPulse,
  List,
  RefreshCw,
  Search,
  Wrench,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  inspectMcpLog,
  type McpLogOperation,
} from '@/lib/observability/mcp-log-entry';

export type McpRequestLogView = {
  id: string;
  deploymentId?: string | null;
  deploymentHref?: string | null;
  deploymentName?: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string | null;
  time: string;
};

type Filter = 'all' | 'failed' | 'slow';
type Translate = (key: string, values?: Record<string, string | number>) => string;

const SLOW_REQUEST_MS = 500;

const operationIcons: Record<McpLogOperation, ComponentType<{ className?: string }>> = {
  toolCall: Wrench,
  listTools: List,
  initialize: Braces,
  healthCheck: HeartPulse,
  ping: Activity,
  notification: Activity,
  request: Braces,
};

function pretty(value: string | null): string {
  if (!value) return '—';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function operationLabel(operation: McpLogOperation, t: Translate): string {
  switch (operation) {
    case 'toolCall': return t('toolCall');
    case 'listTools': return t('listTools');
    case 'initialize': return t('initialize');
    case 'healthCheck': return t('healthCheck');
    case 'ping': return t('ping');
    case 'notification': return t('notification');
    default: return t('mcpRequest');
  }
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'danger' | 'warning';
}) {
  const toneClass = tone === 'danger'
    ? 'text-red-700 dark:text-red-400'
    : tone === 'warning'
      ? 'text-amber-700 dark:text-amber-400'
      : 'text-foreground';
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

function Payload({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
        {pretty(value)}
      </pre>
    </div>
  );
}

export function McpRequestLogs({
  logs,
  showServer = false,
  refreshIntervalMs = 0,
}: {
  logs: McpRequestLogView[];
  showServer?: boolean;
  refreshIntervalMs?: number;
}) {
  const t = useTranslations('console.observability') as Translate;
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [isRefreshing, startRefresh] = useTransition();

  const rows = useMemo(() => logs.map((log) => ({
    log,
    inspection: inspectMcpLog(log),
  })), [logs]);
  const failed = rows.filter((row) => row.inspection.outcome === 'error').length;
  const slow = rows.filter((row) => row.log.durationMs >= SLOW_REQUEST_MS).length;
  const average = rows.length
    ? Math.round(rows.reduce((total, row) => total + row.log.durationMs, 0) / rows.length)
    : 0;
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = rows.filter(({ log, inspection }) => {
    if (filter === 'failed' && inspection.outcome !== 'error') return false;
    if (filter === 'slow' && log.durationMs < SLOW_REQUEST_MS) return false;
    if (!normalizedQuery) return true;
    return [
      inspection.operation,
      inspection.rpcMethod,
      inspection.toolName,
      log.deploymentName,
      log.method,
      log.path,
      inspection.errorSummary,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery);
  });
  const filtersActive = filter !== 'all' || Boolean(query);

  function refresh() {
    startRefresh(() => router.refresh());
  }

  useEffect(() => {
    if (!refreshIntervalMs) return;
    const timer = window.setInterval(() => {
      startRefresh(() => router.refresh());
    }, refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshIntervalMs, router, startRefresh]);

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setQuery('');
    setFilter('all');
  }

  return (
    <section className="space-y-4" aria-label={t('requestLog')}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={t('requests')} value={logs.length} />
        <Metric label={t('failedRequests')} value={failed} tone={failed ? 'danger' : 'default'} />
        <Metric label={t('avgLatency')} value={`${average}${t('ms')}`} />
        <Metric
          label={t('slowRequests', { threshold: SLOW_REQUEST_MS })}
          value={slow}
          tone={slow ? 'warning' : 'default'}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchLogs')}
            aria-label={t('searchLogs')}
            className="ui-input ui-input-icon h-9 w-full"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border bg-background p-0.5" role="group" aria-label={t('filterLogs')}>
            {([
              ['all', t('allLogs'), logs.length],
              ['failed', t('failedRequests'), failed],
              ['slow', t('slowRequests', { threshold: SLOW_REQUEST_MS }), slow],
            ] as const).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  filter === value
                    ? value === 'failed'
                      ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                      : value === 'slow'
                        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {label} <span className="tabular-nums">{count}</span>
              </button>
            ))}
          </div>
          {refreshIntervalMs ? (
            <button
              type="button"
              onClick={refresh}
              disabled={isRefreshing}
              className="ui-button-secondary h-9 text-xs"
            >
              <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              {t('refresh')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t('showingFilteredRequests', { shown: filtered.length, total: logs.length })}</span>
        {refreshIntervalMs ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {t('autoRefreshing')}
          </span>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="ui-empty min-h-44">
          <Search className="mb-3 size-7 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noMatchingRequests')}</p>
          {filtersActive ? (
            <button type="button" onClick={clearFilters} className="ui-button-secondary ui-button-sm mt-4">
              <X className="size-3.5" />
              {t('clearLogFilters')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="max-h-[42rem] overflow-auto rounded-lg border border-border bg-card">
          <div className="divide-y divide-border">
            {filtered.map(({ log, inspection }) => {
              const expanded = open.has(log.id);
              const Icon = operationIcons[inspection.operation];
              const detailsId = `mcp-log-details-${log.id}`;
              const isError = inspection.outcome === 'error';
              const readableOperation = operationLabel(inspection.operation, t);
              const rowLabel = [
                readableOperation,
                inspection.toolName,
                isError ? t('error') : t('success'),
                log.time,
              ].filter(Boolean).join(' · ');
              return (
                <article key={log.id} className={isError ? 'bg-red-500/[0.025]' : undefined}>
                  <button
                    type="button"
                    onClick={() => toggle(log.id)}
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    aria-label={rowLabel}
                    className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                  >
                    <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
                      isError
                        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                        : inspection.operation === 'toolCall'
                          ? 'bg-brand/10 text-brand'
                          : 'bg-muted text-muted-foreground'
                    }`}>
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium text-foreground">{readableOperation}</span>
                        {inspection.toolName ? (
                          <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                            {inspection.toolName}
                          </code>
                        ) : null}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">{log.method}</span>
                        <span aria-hidden="true">·</span>
                        <span>{log.time}</span>
                        {inspection.rpcMethod && inspection.operation !== 'toolCall' ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{inspection.rpcMethod}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 pt-0.5">
                      <span className={`hidden rounded-full px-2 py-0.5 text-xs font-semibold sm:inline-flex ${
                        isError
                          ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      }`}>
                        {isError ? t('error') : t('success')}
                      </span>
                      <span className={`hidden items-center gap-1 text-xs tabular-nums md:inline-flex ${
                        log.durationMs >= SLOW_REQUEST_MS
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-muted-foreground'
                      }`}>
                        <Clock3 className="size-3.5" />
                        {log.durationMs}{t('ms')}
                      </span>
                      <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </span>
                  </button>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-3 pl-[3.75rem] text-xs text-muted-foreground">
                    <span className={`inline-flex rounded-full px-2 py-0.5 font-semibold sm:hidden ${
                      isError
                        ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                        : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    }`}>
                      {isError ? t('error') : t('success')}
                    </span>
                    <span className={`inline-flex items-center gap-1 tabular-nums md:hidden ${
                      log.durationMs >= SLOW_REQUEST_MS
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-muted-foreground'
                    }`}>
                      <Clock3 className="size-3.5" />
                      {log.durationMs}{t('ms')}
                    </span>
                    <span>{t('httpStatus', { status: log.statusCode })}</span>
                    {showServer && log.deploymentName ? (
                      <>
                        <span aria-hidden="true">·</span>
                        {log.deploymentHref ? (
                          <Link href={log.deploymentHref} className="font-medium text-foreground hover:underline">
                            {log.deploymentName}
                          </Link>
                        ) : (
                          <span className="font-medium text-foreground">{log.deploymentName}</span>
                        )}
                      </>
                    ) : null}
                  </div>

                  {isError && inspection.errorSummary ? (
                    <p className="mx-4 mb-3 ml-[3.75rem] flex items-start gap-1.5 rounded-md border border-red-500/15 bg-red-500/[0.06] px-2.5 py-2 text-xs leading-5 text-red-700 dark:text-red-300">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span>{inspection.errorSummary}</span>
                    </p>
                  ) : null}

                  {expanded ? (
                    <div id={detailsId} className="border-t border-border bg-muted/[0.18] px-4 py-4">
                      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span><span className="font-medium text-foreground">{t('rawEndpoint')}:</span> <code className="break-all font-mono">{log.path}</code></span>
                        <span><span className="font-medium text-foreground">{t('status')}:</span> {t('httpStatus', { status: log.statusCode })}</span>
                        <span><span className="font-medium text-foreground">{t('duration')}:</span> {log.durationMs}{t('ms')}</span>
                      </div>
                      <div className="grid gap-4 lg:grid-cols-2">
                        <Payload label={t('request')} value={log.requestBody} />
                        <Payload label={t('response')} value={log.responseBody} />
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
