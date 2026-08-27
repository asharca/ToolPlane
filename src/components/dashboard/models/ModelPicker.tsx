'use client';

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { Popover } from 'radix-ui';
import { Loader2, Search, Settings2, X } from 'lucide-react';

export type ModelProviderOption = {
  id: string;
  name: string;
  models: string[];
};

export type ModelSelection = {
  providerId: string;
  model: string;
};

export function ModelPicker({
  providers,
  value,
  onSelect,
  trigger,
  open: controlledOpen,
  onOpenChange,
  pending = false,
  pendingValue = null,
  error,
  closeOnSelect = true,
  onConfigure,
}: {
  providers: ModelProviderOption[];
  value: ModelSelection | null;
  onSelect: (selection: ModelSelection) => void;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  pending?: boolean;
  pendingValue?: ModelSelection | null;
  error?: string | null;
  closeOnSelect?: boolean;
  onConfigure?: () => void;
}) {
  const t = useTranslations('console.agents');
  const [internalOpen, setInternalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const open = controlledOpen ?? internalOpen;
  const selected = pending && pendingValue ? pendingValue : value;
  const selectedKey = selected ? `${selected.providerId}\0${selected.model}` : '';

  const setOpen = useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    if (!nextOpen) setSearch('');
    onOpenChange?.(nextOpen);
  }, [controlledOpen, onOpenChange]);

  const visibleProviders = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return providers.flatMap((provider) => {
      const cachedModels = [...new Set(provider.models.filter(Boolean))];
      const allModels = provider.id === value?.providerId && value.model && !cachedModels.includes(value.model)
        ? [value.model, ...cachedModels]
        : cachedModels;
      const providerMatches = provider.name.toLocaleLowerCase().includes(query)
        || provider.id.toLocaleLowerCase().includes(query);
      const models = !query || providerMatches
        ? allModels
        : allModels.filter((model) => model.toLocaleLowerCase().includes(query));
      return models.length ? [{ ...provider, models }] : [];
    });
  }, [providers, search, value]);

  const setListElement = useCallback((list: HTMLDivElement | null) => {
    if (!list) return;
    window.requestAnimationFrame(() => {
      const option = list.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      if (option) list.scrollTop = option.offsetTop - list.offsetTop - 28;
    });
  }, []);

  const handleOptionKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) return;
    const options = Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(event.currentTarget);
    const nextIndex = event.key === 'PageDown'
      ? Math.min(options.length - 1, index + 10)
      : event.key === 'PageUp'
        ? Math.max(0, index - 10)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[nextIndex]?.focus();
  }, []);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          aria-label={t('modelConfiguration')}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          className="z-[60] flex h-[440px] max-h-[var(--radix-popover-content-available-height)] w-[400px] max-w-[calc(100vw-1rem)] origin-[var(--radix-popover-content-transform-origin)] flex-col overflow-hidden rounded-lg border-[0.5px] border-border bg-popover pt-1 text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
        >
          <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-0 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                autoFocus
                spellCheck={false}
                aria-label={t('searchModels')}
                placeholder={t('searchModels')}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'PageDown'].includes(event.key)) return;
                  event.preventDefault();
                  contentRef.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')?.focus();
                }}
                className="h-7 w-full border-0 bg-transparent py-0 pl-5 pr-6 text-xs leading-7 text-foreground outline-none placeholder:text-muted-foreground"
              />
              {search ? (
                <button
                  type="button"
                  aria-label={t('clearModelSearch')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setSearch('');
                    searchRef.current?.focus();
                  }}
                  className="absolute right-0 top-1/2 flex size-[22px] -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                >
                  <X className="size-2.5" />
                </button>
              ) : null}
            </div>
          </div>

          <div ref={setListElement} className="min-h-0 flex-1 overflow-y-auto pb-1" role="listbox" aria-label={t('selectModel')}>
            {visibleProviders.length ? visibleProviders.map((provider) => (
              <div key={provider.id} role="group" aria-label={provider.name}>
                <div className="sticky top-0 z-10 flex h-7 items-center bg-popover px-4 text-[11px] text-muted-foreground">
                  <span className="truncate">{provider.name}</span>
                </div>
                {provider.models.map((model) => {
                  const key = `${provider.id}\0${model}`;
                  const isSelected = selectedKey === key;
                  return (
                    <div key={key} className="px-1 py-0.5">
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        disabled={pending}
                        onClick={() => {
                          onSelect({ providerId: provider.id, model });
                          if (closeOnSelect) setOpen(false);
                        }}
                        onKeyDown={handleOptionKeyDown}
                        className={`group relative flex h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors disabled:cursor-wait disabled:opacity-60 ${isSelected ? 'bg-accent/70 text-accent-foreground' : 'text-foreground hover:bg-accent/60 focus:bg-accent/60 focus:outline-none'}`}
                      >
                        {isSelected ? <span aria-hidden="true" className="absolute left-0 top-1/2 h-[60%] w-[3px] -translate-y-1/2 rounded-full bg-primary" /> : null}
                        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                          {provider.name.charAt(0).toUpperCase() || 'M'}
                        </span>
                        <span className="min-w-0 flex-1 truncate" title={model}>{model}</span>
                        {pending && pendingValue?.providerId === provider.id && pendingValue.model === model
                          ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                          : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            )) : (
              <div className="flex h-full items-center justify-center px-3 py-4 text-xs text-muted-foreground">
                {t('noMatchingModels')}
              </div>
            )}
          </div>

          {error ? <p role="alert" className="mx-2 mb-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
          {onConfigure ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onConfigure();
              }}
              className="flex w-full shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <Settings2 className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{t('configureModelProviders')}</span>
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
