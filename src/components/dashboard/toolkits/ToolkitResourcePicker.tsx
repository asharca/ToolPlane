'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  useActionState,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Brain, Plus, Search, Server, X } from 'lucide-react';
import {
  addServersToToolkitAction,
  addSkillsToToolkitAction,
  type ToolkitBatchActionState,
} from '@/lib/toolkits/actions';
import { MAX_TOOLKIT_BATCH_ITEMS } from '@/lib/toolkits/limits';

const TOOLKIT_PICKER_RENDER_LIMIT = 100;

export type ToolkitPickerItem = {
  id: string;
  name: string;
  description: string | null;
  source: string;
  status?: string | null;
  keywords: string[];
};

function sourceLabel(source: string, t: ReturnType<typeof useTranslations>): string {
  const known: Record<string, string> = {
    catalog: t('sourceCatalog'),
    custom: t('sourceCustom'),
    github: 'GitHub',
    upload: t('sourceUpload'),
    npm: 'npm',
    pypi: 'PyPI',
    docker: 'Docker',
  };
  return known[source] ?? source;
}

function statusLabel(status: string, t: ReturnType<typeof useTranslations>): string {
  const known: Record<string, string> = {
    running: t('statusRunning'),
    provisioning: t('statusProvisioning'),
    stopped: t('statusStopped'),
    error: t('statusError'),
  };
  return known[status] ?? status;
}

export function ToolkitResourcePicker({
  kind,
  workspaceSlug,
  toolkitSlug,
  items,
  emptyHref,
}: {
  kind: 'mcp' | 'skill';
  workspaceSlug: string;
  toolkitSlug: string;
  items: ToolkitPickerItem[];
  emptyHref: string;
}) {
  const t = useTranslations('console.toolkits');
  const action = kind === 'mcp' ? addServersToToolkitAction : addSkillsToToolkitAction;
  const [state, formAction, isPending] = useActionState<ToolkitBatchActionState, FormData>(action, {});
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const selectAllRef = useRef<HTMLInputElement>(null);

  const sourceOptions = useMemo(
    () => [...new Set(items.map((item) => item.source))].sort(),
    [items],
  );
  const statusOptions = useMemo(
    () => [...new Set(items.map((item) => item.status).filter((value): value is string => Boolean(value)))].sort(),
    [items],
  );
  const availableIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const activeSelected = useMemo(
    () => new Set([...selected].filter((id) => availableIds.has(id))),
    [availableIds, selected],
  );
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (source !== 'all' && item.source !== source) return false;
      if (status !== 'all' && item.status !== status) return false;
      if (!deferredQuery) return true;
      const haystack = [item.name, item.description ?? '', item.source, item.status ?? '', ...item.keywords]
        .join(' ')
        .toLowerCase();
      return haystack.includes(deferredQuery);
    });
  }, [deferredQuery, items, source, status]);
  const renderedItems = filteredItems.slice(0, TOOLKIT_PICKER_RENDER_LIMIT);

  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every((item) => activeSelected.has(item.id));
  const someFilteredSelected = filteredItems.some((item) => activeSelected.has(item.id));
  const selectingAllWouldExceedLimit =
    activeSelected.size + filteredItems.filter((item) => !activeSelected.has(item.id)).length >
    MAX_TOOLKIT_BATCH_ITEMS;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [allFilteredSelected, someFilteredSelected]);

  const title = kind === 'mcp' ? t('availableMcp') : t('availableSkills');
  const hasFilters = Boolean(query || source !== 'all' || status !== 'all');

  function toggleItem(id: string) {
    if (!activeSelected.has(id) && activeSelected.size >= MAX_TOOLKIT_BATCH_ITEMS) return;
    setSelected((current) => {
      const next = new Set([...current].filter((selectedId) => availableIds.has(selectedId)));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFiltered() {
    if (!allFilteredSelected && selectingAllWouldExceedLimit) return;
    setSelected((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      if (allFilteredSelected) filteredItems.forEach((item) => next.delete(item.id));
      else filteredItems.forEach((item) => next.add(item.id));
      return next;
    });
  }

  function clearFilters() {
    setQuery('');
    setSource('all');
    setStatus('all');
  }

  if (items.length === 0) {
    return (
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          <span className="text-sm text-muted-foreground">0</span>
        </header>
        <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {kind === 'mcp' ? t('everyDeployedServerIsAlreadyInThisToolkit') : t('everyInstalledSkillIsAlreadyInThisToolkit')}{' '}
          <Link href={emptyHref} className="text-zinc-700 underline dark:text-zinc-300">
            {kind === 'mcp' ? t('deployMore') : t('installMore')}
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          <span className="text-sm text-muted-foreground">{items.length}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {t('matchingResources', { count: filteredItems.length })}
        </span>
      </header>

      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={kind === 'mcp' ? t('searchAvailableMcp') : t('searchAvailableSkills')}
              aria-label={kind === 'mcp' ? t('searchAvailableMcp') : t('searchAvailableSkills')}
              className="ui-input ui-input-icon h-9 w-full"
            />
          </div>
          <div className="w-full shrink-0 sm:w-40">
            <select value={source} onChange={(event) => setSource(event.target.value)} aria-label={t('filterBySource')} className="ui-input h-9">
              <option value="all">{t('allSources')}</option>
              {sourceOptions.map((value) => <option key={value} value={value}>{sourceLabel(value, t)}</option>)}
            </select>
          </div>
          {kind === 'mcp' ? (
            <div className="w-full shrink-0 sm:w-40">
              <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label={t('filterByStatus')} className="ui-input h-9">
                <option value="all">{t('allStatuses')}</option>
                {statusOptions.map((value) => <option key={value} value={value}>{statusLabel(value, t)}</option>)}
              </select>
            </div>
          ) : null}
          {hasFilters ? (
            <button type="button" onClick={clearFilters} className="ui-button-ghost h-9 shrink-0">
              <X className="size-4" />
              {t('clearFilters')}
            </button>
          ) : null}
      </div>

      <form action={formAction}>
        <input type="hidden" name="workspace" value={workspaceSlug} />
        <input type="hidden" name="toolkitSlug" value={toolkitSlug} />
        {[...activeSelected].map((id) => <input key={id} type="hidden" name="resourceId" value={id} />)}
        <div className="flex flex-wrap items-center justify-between gap-2 border-y border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allFilteredSelected}
                disabled={!allFilteredSelected && selectingAllWouldExceedLimit}
                onChange={toggleFiltered}
                className="size-4 accent-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:accent-zinc-100"
              />
              {t('selectVisible', { count: filteredItems.length })}
            </label>
            <span className="text-xs text-muted-foreground">
              {t('selectedResources', { count: activeSelected.size })}
            </span>
            {activeSelected.size > 0 ? (
              <button type="button" onClick={() => setSelected(new Set())} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                {t('clearSelection')}
              </button>
            ) : null}
            {!allFilteredSelected && selectingAllWouldExceedLimit ? (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                {t('narrowFiltersToSelectAll', { count: MAX_TOOLKIT_BATCH_ITEMS })}
              </span>
            ) : null}
          </div>
          <button type="submit" disabled={activeSelected.size === 0 || isPending} className="ui-button-primary ui-button-sm disabled:cursor-not-allowed disabled:opacity-50">
            <Plus className="size-3.5" />
            {isPending ? t('addingSelected') : t('addSelected', { count: activeSelected.size })}
          </button>
        </div>

        {state.error ? <p className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300" role="alert">{state.error}</p> : null}
        {!state.error && typeof state.added === 'number' ? (
          <p className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300" role="status">
            {t('addedResources', { count: state.added })}
          </p>
        ) : null}
      </form>

      {filteredItems.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">{t('noResourcesMatchFilters')}</p>
          <button type="button" onClick={clearFilters} className="ui-button-ghost ui-button-sm mt-2">
            {t('clearFilters')}
          </button>
        </div>
      ) : (
        <>
          {filteredItems.length > renderedItems.length ? (
            <p className="border-b border-zinc-100 bg-zinc-50/70 px-4 py-2 text-xs text-muted-foreground dark:border-zinc-800 dark:bg-zinc-900/40">
              {t('showingFirstResources', {
                shown: renderedItems.length,
                count: filteredItems.length,
              })}
            </p>
          ) : null}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {renderedItems.map((item) => {
              const isSelected = activeSelected.has(item.id);
              const Icon = kind === 'mcp' ? Server : Brain;
              return (
                <li key={item.id}>
                  <label className={`flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900 ${isSelected ? 'bg-zinc-50 dark:bg-zinc-900/70' : ''}`}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleItem(item.id)}
                      aria-label={t('selectResource', { name: item.name })}
                      className="mt-1 size-4 shrink-0 accent-zinc-900 dark:accent-zinc-100"
                    />
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                      <Icon className="size-4 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.name}</span>
                      {item.description ? <span className="mt-0.5 block line-clamp-1 text-xs text-muted-foreground">{item.description}</span> : null}
                    </span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {sourceLabel(item.source, t)}
                      </span>
                      {item.status ? (
                        <span className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                          {statusLabel(item.status, t)}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
