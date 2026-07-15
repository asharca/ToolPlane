'use client';

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import { Search, X, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { NativeSelect } from '@/components/ui/NativeSelect';

const RESOURCE_RENDER_LIMIT = 100;

export type AgentResourceOption = {
  id: string;
  label: string;
  checked?: boolean;
  description?: string | null;
  source?: string | null;
  status?: string | null;
  keywords?: string[];
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
    enabled: t('statusEnabled'),
    disabled: t('statusDisabled'),
    published: t('statusPublished'),
    draft: t('statusDraft'),
  };
  return known[status] ?? status;
}

export function AgentResourceSelect({
  icon: Icon,
  label,
  name,
  options,
  selectedIds,
  onSelectionChange,
}: {
  icon: LucideIcon;
  label: string;
  name: string;
  options: AgentResourceOption[];
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
}) {
  const t = useTranslations('console.agents');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState('all');
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const selectAllRef = useRef<HTMLInputElement>(null);

  const availableIds = useMemo(() => new Set(options.map((option) => option.id)), [options]);
  const activeSelected = useMemo(
    () => new Set([...selectedIds].filter((id) => availableIds.has(id))),
    [availableIds, selectedIds],
  );
  const sourceOptions = useMemo(
    () => [...new Set(options.map((option) => option.source).filter((value): value is string => Boolean(value)))].sort(),
    [options],
  );
  const statusOptions = useMemo(
    () => [...new Set(options.map((option) => option.status).filter((value): value is string => Boolean(value)))].sort(),
    [options],
  );
  const filteredOptions = useMemo(() => options.filter((option) => {
    if (source !== 'all' && option.source !== source) return false;
    if (status !== 'all' && option.status !== status) return false;
    if (!deferredQuery) return true;

    return [
      option.label,
      option.description ?? '',
      option.source ?? '',
      option.status ?? '',
      ...(option.keywords ?? []),
    ].join(' ').toLowerCase().includes(deferredQuery);
  }), [deferredQuery, options, source, status]);
  const renderedOptions = filteredOptions.slice(0, RESOURCE_RENDER_LIMIT);
  const allFilteredSelected = filteredOptions.length > 0
    && filteredOptions.every((option) => activeSelected.has(option.id));
  const someFilteredSelected = filteredOptions.some((option) => activeSelected.has(option.id));
  const hasFilters = Boolean(query || source !== 'all' || status !== 'all');

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [allFilteredSelected, someFilteredSelected]);

  function stopFormChange(event: SyntheticEvent) {
    event.stopPropagation();
  }

  function clearFilters() {
    setQuery('');
    setSource('all');
    setStatus('all');
  }

  function toggleOption(id: string, checked: boolean) {
    const next = new Set(activeSelected);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange(next);
  }

  function toggleFiltered() {
    const next = new Set(activeSelected);
    if (allFilteredSelected) filteredOptions.forEach((option) => next.delete(option.id));
    else filteredOptions.forEach((option) => next.add(option.id));
    onSelectionChange(next);
  }

  return (
    <fieldset className="min-w-0 rounded-md border border-border bg-muted/15">
      <legend className="ml-3 px-1">
        <span className="inline-flex items-center gap-2 text-xs font-semibold text-foreground">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          {label}
        </span>
      </legend>

      {[...activeSelected].map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}

      {options.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">{t('nothingAvailableInThisWorkspace')}</p>
      ) : (
        <div className="mt-1">
          <div className="space-y-2 border-b border-border px-3 pb-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  stopFormChange(event);
                  setQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                  event.stopPropagation();
                }}
                placeholder={t('searchResources', { resource: label })}
                aria-label={t('searchResources', { resource: label })}
                className="ui-input ui-input-icon h-9 w-full"
              />
            </div>

            {sourceOptions.length > 1 || statusOptions.length > 1 ? (
              <div className="flex gap-2">
                {sourceOptions.length > 1 ? (
                  <NativeSelect
                    value={source}
                    onChange={(event) => {
                      stopFormChange(event);
                      setSource(event.target.value);
                    }}
                    aria-label={`${label}: ${t('filterBySource')}`}
                    className="ui-input h-9"
                    wrapperClassName="min-w-0 flex-1"
                  >
                    <option value="all">{t('allSources')}</option>
                    {sourceOptions.map((value) => (
                      <option key={value} value={value}>{sourceLabel(value, t)}</option>
                    ))}
                  </NativeSelect>
                ) : null}
                {statusOptions.length > 1 ? (
                  <NativeSelect
                    value={status}
                    onChange={(event) => {
                      stopFormChange(event);
                      setStatus(event.target.value);
                    }}
                    aria-label={`${label}: ${t('filterByStatus')}`}
                    className="ui-input h-9"
                    wrapperClassName="min-w-0 flex-1"
                  >
                    <option value="all">{t('allStatuses')}</option>
                    {statusOptions.map((value) => (
                      <option key={value} value={value}>{statusLabel(value, t)}</option>
                    ))}
                  </NativeSelect>
                ) : null}
                {hasFilters ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    aria-label={t('clearFilters')}
                    title={t('clearFilters')}
                    className="ui-button-ghost size-9 shrink-0 p-0"
                  >
                    <X className="size-4" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/60 px-3 py-2.5">
            <label className="inline-flex min-w-0 cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allFilteredSelected}
                disabled={filteredOptions.length === 0}
                onChange={(event) => {
                  stopFormChange(event);
                  toggleFiltered();
                }}
                className="size-4 shrink-0"
              />
              <span className="truncate">{t('selectMatches', { count: filteredOptions.length })}</span>
            </label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('selectedResources', { count: activeSelected.size })}
            </span>
            {activeSelected.size > 0 ? (
              <button
                type="button"
                onClick={() => onSelectionChange(new Set())}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {t('clearSelection')}
              </button>
            ) : null}
          </div>

          {filteredOptions.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">{t('noResourcesMatchFilters')}</p>
              {hasFilters ? (
                <button type="button" onClick={clearFilters} className="ui-button-ghost mt-2 h-8 px-2 text-xs">
                  {t('clearFilters')}
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {filteredOptions.length > renderedOptions.length ? (
                <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                  {t('showingFirstMatches', { shown: renderedOptions.length, total: filteredOptions.length })}
                </p>
              ) : null}
              <div className="max-h-64 overflow-y-auto">
                {renderedOptions.map((option) => {
                  const isSelected = activeSelected.has(option.id);
                  return (
                    <label
                      key={option.id}
                      className={`flex min-h-10 cursor-pointer items-start gap-2.5 border-b border-border/60 px-3 py-2 text-sm transition-colors last:border-b-0 hover:bg-background ${isSelected ? 'bg-background' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(event) => {
                          stopFormChange(event);
                          toggleOption(option.id, event.target.checked);
                        }}
                        aria-label={t('selectResource', { name: option.label })}
                        className="mt-0.5 size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground">{option.label}</span>
                        {option.description ? (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{option.description}</span>
                        ) : null}
                      </span>
                      {option.source || option.status ? (
                        <span className="flex shrink-0 flex-wrap justify-end gap-1">
                          {option.source ? (
                            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {sourceLabel(option.source, t)}
                            </span>
                          ) : null}
                          {option.status ? (
                            <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {statusLabel(option.status, t)}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
