'use client';

import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { useTranslations } from 'next-intl';
import { MorphPopover, MorphPopoverTrigger, MorphPopoverContent } from '@/components/motion/popover-morph';
import {
  ChevronDown,
  Loader2,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import {
  MODEL_PRIMARY_TYPES,
  inferModelPrimaryType,
  type ModelPrimaryType,
} from '@/lib/agents/model-catalog';

export type ModelRecordOption = {
  modelId: string;
  primaryType: string;
  capabilities?: string[];
  inputModalities?: string[];
  cost?: unknown;
};

export type ModelProviderOption = {
  id: string;
  name: string;
  models: string[];
  modelRecords?: ModelRecordOption[];
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
  trigger: ReactElement;
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
  const common = useTranslations('common');
  const [search, setSearch] = useState('');
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<{ side: 'top' | 'bottom'; align: 'start' | 'end'; width: number; height: number }>({ side: 'bottom', align: 'start', width: 320, height: 384 });
  const open = controlledOpen ?? internalOpen;
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top - 16;
      const below = window.innerHeight - rect.bottom - 16;
      const align = rect.left + rect.width / 2 <= window.innerWidth / 2 ? 'start' : 'end';
      setPlacement({
        side: below >= above ? 'bottom' : 'top',
        align,
        width: Math.min(320, align === 'start' ? window.innerWidth - rect.left - 8 : rect.right - 8),
        height: Math.min(384, Math.max(above, below)),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  const selected = pending && pendingValue ? pendingValue : value;
  const selectedKey = selected ? `${selected.providerId}\0${selected.model}` : '';
  const typeLabels: Record<ModelPrimaryType, string> = {
    text: t('modelTypeText'),
    image: t('modelTypeImage'),
    embedding: t('modelTypeEmbedding'),
    rerank: t('modelTypeRerank'),
  };

  const setOpen = useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    if (!nextOpen) {
      setSearch('');
      if (contentRef.current?.contains(document.activeElement)) {
        anchorRef.current?.querySelector<HTMLElement>('[aria-haspopup="dialog"]')?.focus();
      }
    }
    onOpenChange?.(nextOpen);
  }, [controlledOpen, onOpenChange]);

  const visibleProviders = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return providers.flatMap((provider) => {
      const records = new Map(provider.modelRecords?.map((record) => [record.modelId, record]));
      const cachedModels = [...new Set(provider.models.filter(Boolean))];
      const allModels = provider.id === value?.providerId && value.model && !cachedModels.includes(value.model)
        ? [value.model, ...cachedModels]
        : cachedModels;
      const providerMatches = provider.name.toLocaleLowerCase().includes(query)
        || provider.id.toLocaleLowerCase().includes(query);
      const models = !query || providerMatches
        ? allModels
        : allModels.filter((model) => model.toLocaleLowerCase().includes(query));
      return models.length ? [{ ...provider, models, records }] : [];
    });
  }, [providers, search, value]);

  const setListElement = useCallback((list: HTMLDivElement | null) => {
    if (!list) return;
    window.requestAnimationFrame(() => {
      const option = list.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      if (option) list.scrollTop += option.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
  }, []);

  const handleOptionKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) return;
    const options = Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []).filter((option) => !option.closest('[inert]'));
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
    <span ref={anchorRef} className="inline-flex max-w-full min-w-0">
    <MorphPopover open={open} onOpenChange={setOpen} className="max-w-full min-w-0">
      <MorphPopoverTrigger>{trigger}</MorphPopoverTrigger>
      <MorphPopoverContent side={placement.side} align={placement.align} className="max-w-[calc(100vw-1rem)]">
        <div ref={contentRef} style={{ width: placement.width, height: placement.height }} className="flex max-w-full min-w-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2.5 py-2">
            <div className="relative min-w-0 flex-1">
              <Input leftIcon={<Search />}
                rightIcon={search ? (
                  <Button type="button" variant="ghost" size="icon" aria-label={t('clearModelSearch')} onMouseDown={(event) => event.preventDefault()} onClick={() => { setSearch(''); searchRef.current?.focus(); }}>
                    <X className="size-2.5" />
                  </Button>
                ) : undefined}
                ref={searchRef}
                type="text"
                value={search}
                spellCheck={false}
                aria-label={t('searchModels')}
                placeholder={t('searchModels')}
                onChange={(value) => setSearch(value)}
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'PageDown'].includes(event.key)) return;
                  event.preventDefault();
                  Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []).find((option) => !option.closest('[inert]'))?.focus();
                }}
                className="w-full"
                classNames={{ root: 'min-w-0', field: 'h-8 shrink-0 rounded-lg', input: 'min-w-0 text-xs text-left' }}
              />
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={common('close')} onClick={() => setOpen(false)} className="size-7 shrink-0 rounded-lg text-muted-foreground"><X className="size-3.5" /></Button>
          </div>

          <div role="listbox" aria-label={t('selectModel')} className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-1.5">
            {visibleProviders.length ? visibleProviders.map((provider) => {
              const expanded = Boolean(search.trim()) || !collapsedProviders.has(provider.id);
              return (
              <div key={provider.id} role="group" aria-label={provider.name}>
                <button type="button" aria-label={provider.name} aria-expanded={expanded}
                  aria-controls={`model-provider-${encodeURIComponent(provider.id)}`}
                  onClick={() => setCollapsedProviders((current) => {
                    const next = new Set(current);
                    if (next.has(provider.id)) next.delete(provider.id); else next.add(provider.id);
                    return next;
                  })}
                  className="group flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md bg-card px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="min-w-0 flex-1 truncate" title={provider.name}>{provider.name}</span>
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-background px-1.5 text-[10px] font-normal tabular-nums text-muted-foreground">{provider.models.length}</span>
                  <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${expanded ? '' : '-rotate-90'}`} />
                </button>
                <div id={`model-provider-${encodeURIComponent(provider.id)}`}
                  aria-hidden={!expanded} inert={!expanded}
                  className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="min-h-0 overflow-hidden">
                <div ref={setListElement} className="relative max-h-40 overflow-y-auto overscroll-contain pt-1">
                {provider.models.map((model) => {
                  const key = `${provider.id}\0${model}`;
                  const isSelected = selectedKey === key;
                  const record = provider.records.get(model);
                  const cost = record?.cost;
                  const price = (field: 'input' | 'output') => {
                    const rate = cost && typeof cost === 'object' ? (cost as Record<string, unknown>)[field] : null;
                    return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? String(rate) : null;
                  };
                  const inputPrice = price('input');
                  const outputPrice = price('output');
                  const primaryType = MODEL_PRIMARY_TYPES.includes(record?.primaryType as ModelPrimaryType)
                    ? record?.primaryType as ModelPrimaryType
                    : inferModelPrimaryType(model);
                  const labels = [
                    typeLabels[primaryType],
                    ...(record?.capabilities?.includes('reasoning') ? [t('capabilityReasoning')] : []),
                    ...(record?.capabilities?.includes('function_calling') ? [t('capabilityTools')] : []),
                    ...(record?.inputModalities?.includes('image') ? [t('modalityVision')] : []),
                    ...(record?.inputModalities?.includes('audio') ? [t('modalityAudio')] : []),
                    ...(record?.inputModalities?.includes('video') ? [t('modalityVideo')] : []),
                  ];
                  const descriptionId = `model-option-${encodeURIComponent(provider.id)}-${encodeURIComponent(model)}-description`;
                  return (
                    <div key={key} className="px-0.5 py-0.5">
                      <Button type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={pending}
                      aria-label={model}
                      aria-describedby={descriptionId}
                      onClick={() => {
                        onSelect({ providerId: provider.id, model });
                        if (closeOnSelect) setOpen(false);
                      }}
                      onKeyDown={handleOptionKeyDown}
                      variant={isSelected ? 'secondary' : 'ghost'} size="md" className="h-8 w-full min-w-0 justify-start items-center gap-2 rounded-lg px-2 py-1 text-left">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={`${model} — ${labels.join(', ')}`}>{model}</span>
                      <span id={descriptionId} className="sr-only">{labels.join(', ')}{inputPrice !== null ? `; ${t('catalogInputPrice')} ${inputPrice} $/M` : ''}{outputPrice !== null ? `; ${t('catalogOutputPrice')} ${outputPrice} $/M` : ''}</span>
                      {inputPrice !== null || outputPrice !== null ? (
                        <span aria-hidden="true" title={`${t('catalogInputPrice')} / ${t('catalogOutputPrice')} · $/M`} className="shrink-0 whitespace-nowrap text-[10px] leading-4 text-muted-foreground tabular-nums">
                          {inputPrice !== null ? `${inputPrice}$↓` : null}
                          {inputPrice !== null && outputPrice !== null ? <span className="px-0.5 text-muted-foreground/50">/</span> : null}
                          {outputPrice !== null ? `${outputPrice}$↑` : null}
                        </span>
                      ) : null}
                      {pending && pendingValue?.providerId === provider.id && pendingValue.model === model
                        ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        : null}</Button>
                    </div>
                  );
                })}
                </div>
                </div>
                </div>
              </div>
              );
            }) : (
              <div className="flex h-full items-center justify-center px-3 py-4 text-xs text-muted-foreground">
                {t('noMatchingModels')}
              </div>
            )}
          </div>

          {error ? <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">{error}</p> : null}
          {onConfigure ? (
            <footer className="shrink-0 border-t border-border/60 p-1.5">
            <Button type="button"
            onClick={() => {
              setOpen(false);
              onConfigure();
            }}
            variant="ghost" size="sm" className="h-8 w-full justify-start gap-1.5 rounded-lg px-2 text-left text-xs text-muted-foreground"><Settings2 className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{t('configureModelProviders')}</span></Button>
            </footer>
          ) : null}
        </div>
      </MorphPopoverContent>
    </MorphPopover>
    </span>
  );
}
