'use client';

// Domain adapter for https://asharca.github.io/ui/components/blocks/model-selector.
import { Check, Loader2, Search, Settings2, X } from 'lucide-react';
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/motion/button';
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph';
import { useRowCursor } from '@/lib/hooks/use-row-cursor';
import { useOnOpen } from '@/lib/hooks/use-on-open';
import { cn } from '@/lib/utils';
import { MODEL_PRIMARY_TYPES, inferModelPrimaryType, type ModelPrimaryType } from '@/lib/agents/model-catalog';

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

export type ModelSelection = { providerId: string; model: string };

type ModelRow = ModelSelection & {
  id: string;
  provider: string;
  tags: string[];
  description: string;
  inputPrice: string | null;
  outputPrice: string | null;
};

const SIZE_CLASS = {
  sm: {
    panel: 'h-[min(360px,calc(100dvh-24px))] w-[min(320px,calc(100vw-24px))] text-xs',
    row: 'h-7 gap-1.5 px-2 text-xs', icon: 'size-5', search: 'h-9 px-2.5',
    detail: 'w-[min(280px,calc(100vw-24px))] p-3 text-xs',
  },
  md: {
    panel: 'h-[min(440px,calc(100dvh-24px))] w-[min(400px,calc(100vw-24px))] text-xs',
    row: 'h-8 gap-2 px-2 text-xs', icon: 'size-6', search: 'h-10 px-3',
    detail: 'w-[min(336px,calc(100vw-24px))] p-3 text-xs',
  },
  lg: {
    panel: 'h-[min(520px,calc(100dvh-24px))] w-[min(480px,calc(100vw-24px))] text-sm',
    row: 'h-10 gap-2.5 px-3 text-sm', icon: 'size-7', search: 'h-12 px-4',
    detail: 'w-[min(384px,calc(100vw-24px))] p-4 text-sm',
  },
};
const SCROLLBAR_CLASS = '[scrollbar-width:thin] [scrollbar-gutter:stable] [scrollbar-color:color-mix(in_oklab,var(--foreground)_18%,transparent)_transparent] hover:[scrollbar-color:color-mix(in_oklab,var(--foreground)_30%,transparent)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/20 [&::-webkit-scrollbar-thumb:hover]:bg-foreground/30';
const selectionId = (selection: ModelSelection) => JSON.stringify([selection.providerId, selection.model]);

export function ModelPicker({
  providers, value, onSelect, trigger, open: controlledOpen, onOpenChange,
  pending = false, pendingValue = null, error, closeOnSelect = true, onConfigure,
  size = 'md',
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
  size?: 'sm' | 'md' | 'lg';
}) {
  const t = useTranslations('console.agents');
  const uid = useId();
  const sizes = SIZE_CLASS[size];
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const detailAnchor = useRef<HTMLElement | null>(null);
  const detailTimer = useRef<number | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailPosition, setDetailPosition] = useState({ top: 12, left: 12 });
  const [placement, setPlacement] = useState<{ side: 'top' | 'bottom'; align: 'start' | 'end' }>({ side: 'bottom', align: 'start' });
  const selected = pending && pendingValue ? pendingValue : value;
  const selectedId = selected ? selectionId(selected) : '';
  const groups = useMemo(() => {
    const typeLabels: Record<ModelPrimaryType, string> = {
      text: t('modelTypeText'), image: t('modelTypeImage'),
      embedding: t('modelTypeEmbedding'), rerank: t('modelTypeRerank'),
    };
    const search = query.trim().toLocaleLowerCase();
    return providers.flatMap((provider) => {
      const records = new Map(provider.modelRecords?.map((record) => [record.modelId, record]));
      const models = [...new Set(provider.models.filter(Boolean))];
      if (value?.providerId === provider.id && value.model && !models.includes(value.model)) models.unshift(value.model);
      const items = models.map((model): ModelRow => {
        const record = records.get(model);
        const primaryType = MODEL_PRIMARY_TYPES.includes(record?.primaryType as ModelPrimaryType)
          ? record!.primaryType as ModelPrimaryType : inferModelPrimaryType(model);
        const tags = [
          typeLabels[primaryType],
          ...(record?.capabilities?.includes('reasoning') ? [t('capabilityReasoning')] : []),
          ...(record?.capabilities?.includes('function_calling') ? [t('capabilityTools')] : []),
          ...(record?.inputModalities?.includes('image') ? [t('modalityVision')] : []),
          ...(record?.inputModalities?.includes('audio') ? [t('modalityAudio')] : []),
          ...(record?.inputModalities?.includes('video') ? [t('modalityVideo')] : []),
        ];
        const price = (field: 'input' | 'output') => {
          const rate = record?.cost && typeof record.cost === 'object'
            ? (record.cost as Record<string, unknown>)[field] : null;
          return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? String(rate) : null;
        };
        const inputPrice = price('input');
        const outputPrice = price('output');
        return {
          id: selectionId({ providerId: provider.id, model }), providerId: provider.id,
          model, provider: provider.name, tags, inputPrice, outputPrice,
          description: `${tags.join(', ')}${inputPrice !== null ? `; ${t('catalogInputPrice')} ${inputPrice} $/M` : ''}${outputPrice !== null ? `; ${t('catalogOutputPrice')} ${outputPrice} $/M` : ''}`,
        };
      }).filter((model) => [model.model, provider.name, provider.id, ...model.tags].join(' ').toLocaleLowerCase().includes(search));
      return items.length ? [{ id: provider.id, label: provider.name, items }] : [];
    });
  }, [providers, value, query, t]);
  const rows = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const { activeIndex, moveTo, moveActive } = useRowCursor(rows, query);
  const active = rows[activeIndex];
  const detail = open ? rows.find((row) => row.id === detailId) : undefined;

  const clearDetailTimer = () => {
    window.clearTimeout(detailTimer.current);
    detailTimer.current = undefined;
  };
  const hideDetail = () => { clearDetailTimer(); setDetailId(null); };
  const scheduleDetailClose = () => {
    clearDetailTimer();
    detailTimer.current = window.setTimeout(() => setDetailId(null), 100);
  };
  const showDetail = (model: ModelRow, anchor: HTMLElement) => {
    clearDetailTimer();
    if (detailId === model.id) return;
    setDetailId(null);
    detailTimer.current = window.setTimeout(() => {
      detailAnchor.current = anchor;
      setDetailId(model.id);
    }, 1500);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPlacement({
        side: window.innerHeight - rect.bottom >= rect.top ? 'bottom' : 'top',
        align: rect.left + rect.width / 2 <= window.innerWidth / 2 ? 'start' : 'end',
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!detail) return;
    const place = () => {
      const rect = detailAnchor.current?.getBoundingClientRect();
      const card = detailRef.current;
      if (!rect || !card) return;
      const rightSpace = window.innerWidth - rect.right - 20;
      const leftSpace = rect.left - 20;
      const left = rightSpace >= card.offsetWidth || rightSpace >= leftSpace
        ? rect.right + 8 : rect.left - card.offsetWidth - 8;
      const next = {
        left: Math.max(12, Math.min(left, window.innerWidth - card.offsetWidth - 12)),
        top: Math.max(12, Math.min(rect.top, window.innerHeight - card.offsetHeight - 12)),
      };
      setDetailPosition((current) => current.left === next.left && current.top === next.top ? current : next);
    };
    place();
    const observer = new ResizeObserver(place);
    if (detailRef.current) observer.observe(detailRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [detail]);
  useEffect(() => () => window.clearTimeout(detailTimer.current), []);
  useOnOpen(open, () => { setQuery(''); setDetailId(null); moveTo(selectedId || null); });
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, activeIndex]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const changeOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    if (!next) { hideDetail(); setQuery(''); }
    onOpenChange?.(next);
  };
  const close = () => {
    changeOpen(false);
    rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="dialog"]')?.focus();
  };
  const select = (model: ModelRow) => {
    if (pending) return;
    onSelect({ providerId: model.providerId, model: model.model });
    if (closeOnSelect) close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== 'Tab') hideDetail();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      for (let step = 0; step < 12; step++) moveActive(event.key === 'PageDown' ? 1 : -1);
    } else if (event.key === 'Enter' && active) { event.preventDefault(); select(active); }
  };

  return (
    <span ref={rootRef} className="inline-flex max-w-full min-w-0">
      <MorphPopover open={open} onOpenChange={changeOpen} className="max-w-full min-w-0">
        <MorphPopoverTrigger>{trigger}</MorphPopoverTrigger>
        <MorphPopoverContent side={placement.side} align={placement.align} sideOffset={4} radius={12}
          className={cn('flex flex-col bg-card/95 backdrop-blur-xl', sizes.panel)}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className={cn('flex shrink-0 items-center gap-2 border-b border-border', sizes.search)}>
              <Search aria-hidden className="size-3.5 text-muted-foreground" />
              <input ref={inputRef} onKeyDown={onKeyDown} value={query}
                onChange={(event) => { hideDetail(); setQuery(event.target.value); }}
                role="combobox" aria-label={t('searchModels')} aria-expanded="true"
                aria-controls={`${uid}-models`} aria-activedescendant={rows.length ? `${uid}-${activeIndex}` : undefined}
                placeholder={t('searchModels')} spellCheck={false}
                className="h-7 min-w-0 flex-1 bg-transparent text-[inherit] leading-7 outline-none placeholder:text-muted-foreground" />
              {query ? <button type="button" aria-label={t('clearModelSearch')}
                onClick={() => { hideDetail(); setQuery(''); inputRef.current?.focus(); }}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X aria-hidden className="size-4" />
              </button> : null}
              <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
            </div>
            <div ref={listRef} id={`${uid}-models`} role="listbox" aria-label={t('selectModel')}
              aria-busy={pending} onScroll={hideDetail}
              className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2', SCROLLBAR_CLASS)}>
              {rows.length ? groups.map((group) => (
                <div key={group.id} role="group" aria-label={group.label} className="mb-1 last:mb-0">
                  <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">{group.label}</div>
                  {group.items.map((model) => {
                    const index = rows.indexOf(model);
                    const isSelected = model.id === selectedId;
                    return <button key={model.id} id={`${uid}-${index}`} type="button" role="option"
                      aria-label={model.model} aria-selected={isSelected} data-index={index} disabled={pending}
                      onKeyDown={onKeyDown} tabIndex={-1} aria-describedby={`${uid}-${index}-description`}
                      onPointerEnter={(event) => {
                        if (event.pointerType === 'touch') return;
                        moveTo(model.id); showDetail(model, event.currentTarget);
                      }} onPointerLeave={scheduleDetailClose}
                      onFocus={(event) => { moveTo(model.id); showDetail(model, event.currentTarget); }}
                      onBlur={scheduleDetailClose} onClick={() => select(model)}
                      className={cn('relative my-0.5 flex w-full items-center rounded-[10px] text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', sizes.row,
                        index === activeIndex && 'bg-muted/60', isSelected && 'bg-muted/70 text-foreground')}>
                      {isSelected ? <span aria-hidden className="absolute inset-y-[20%] left-0 w-0.5 rounded-full bg-primary" /> : null}
                      <span aria-hidden className={cn('flex shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground', sizes.icon)}>
                        <span className="text-xs font-semibold">{model.model.slice(0, 1)}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate">{model.model}</span>
                      <span id={`${uid}-${index}-description`} className="sr-only">{model.description}</span>
                      {model.inputPrice !== null || model.outputPrice !== null ? <span aria-hidden className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground tabular-nums">
                        {model.inputPrice !== null ? `${model.inputPrice}$↓` : null}
                        {model.inputPrice !== null && model.outputPrice !== null ? '/' : null}
                        {model.outputPrice !== null ? `${model.outputPrice}$↑` : null}
                      </span> : null}
                      {pending && pendingValue && model.id === selectionId(pendingValue)
                        ? <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        : isSelected ? <Check aria-hidden className="size-4 text-primary" /> : null}
                    </button>;
                  })}
                </div>
              )) : <p className="px-3 py-10 text-center text-sm text-muted-foreground">{t('noMatchingModels')}</p>}
            </div>
          </div>
          {error ? <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">{error}</p> : null}
          {onConfigure ? <footer className="shrink-0 border-t border-border/60 p-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => { close(); onConfigure(); }}
              className="h-8 w-full justify-start gap-1.5 rounded-lg px-2 text-left text-xs text-muted-foreground">
              <Settings2 className="size-3.5 shrink-0" /><span className="min-w-0 truncate">{t('configureModelProviders')}</span>
            </Button>
          </footer> : null}
        </MorphPopoverContent>
        {detail ? createPortal(
          <aside ref={detailRef} id={`${uid}-details`} aria-label={detail.model}
            onPointerEnter={clearDetailTimer} onPointerLeave={scheduleDetailClose}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn('fixed z-[10000] max-h-[min(420px,70dvh)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover shadow-xl', sizes.detail, SCROLLBAR_CLASS)}
            style={detailPosition}>
            <p className="break-words text-sm font-medium">{detail.model}</p>
            <dl className="mt-3 space-y-1.5 border-t border-border pt-3 leading-5">
              <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-3">
                <dt className="text-muted-foreground">{t('provider')}</dt><dd className="break-words">{detail.provider}</dd>
              </div>
              <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-3">
                <dt className="text-muted-foreground">{t('model')}</dt><dd className="break-words font-mono">{detail.model}</dd>
              </div>
              {detail.inputPrice !== null ? <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-3">
                <dt className="text-muted-foreground">{t('catalogInputPrice')}</dt><dd>{detail.inputPrice} $/M</dd>
              </div> : null}
              {detail.outputPrice !== null ? <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-3">
                <dt className="text-muted-foreground">{t('catalogOutputPrice')}</dt><dd>{detail.outputPrice} $/M</dd>
              </div> : null}
            </dl>
            <div className="mt-3 flex flex-wrap gap-1.5">{detail.tags.map((tag) => (
              <span key={tag} className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
            ))}</div>
          </aside>, document.body,
        ) : null}
      </MorphPopover>
    </span>
  );
}
