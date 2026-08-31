'use client';

import { useTranslations } from 'next-intl';
import { Popover } from 'radix-ui';
import { ChevronDown, Gauge } from 'lucide-react';
import { type ReasoningEffort } from '@/lib/agents/constants';

const EXPLICIT_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const LABELS = {
  default: 'reasoningEffortDefault',
  minimal: 'reasoningEffortMinimal',
  low: 'reasoningEffortLow',
  medium: 'reasoningEffortMedium',
  high: 'reasoningEffortHigh',
  xhigh: 'reasoningEffortXHigh',
  max: 'reasoningEffortMax',
} as const;

export function ReasoningEffortControl({
  value,
  disabled,
  onChange,
}: {
  value: ReasoningEffort;
  disabled?: boolean;
  onChange: (value: ReasoningEffort) => void;
}) {
  const t = useTranslations('console.agents');
  const explicitIndex = EXPLICIT_EFFORTS.indexOf(value as (typeof EXPLICIT_EFFORTS)[number]);
  const sliderIndex = explicitIndex < 0 ? 2 : explicitIndex;
  const valueLabel = t(LABELS[value]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('reasoningEffort')}
          title={`${t('reasoningEffort')}: ${valueLabel}`}
          className="flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Gauge className="size-4 shrink-0" />
          <span>{valueLabel}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
        >
          <div className="flex min-h-7 items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('reasoningEffort')}:</span>
            <span className="font-medium">{valueLabel}</span>
            {value !== 'default' ? (
              <button
                type="button"
                onClick={() => onChange('default')}
                className="ml-auto h-6 rounded-md bg-muted px-2 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {t('reasoningEffortDefault')}
              </button>
            ) : null}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground" aria-hidden="true">
            <span>{t('reasoningEffortFaster')}</span>
            <span>{t('reasoningEffortSmarter')}</span>
          </div>
          <input
            type="range"
            min={0}
            max={EXPLICIT_EFFORTS.length - 1}
            step={1}
            value={sliderIndex}
            aria-label={t('reasoningEffort')}
            onChange={(event) => onChange(EXPLICIT_EFFORTS[Number(event.target.value)] ?? 'medium')}
            className="mt-1 h-7 w-full cursor-pointer accent-brand"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground" aria-hidden="true">
            <span>{t('reasoningEffortMinimal')}</span>
            <span>{t('reasoningEffortMax')}</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
