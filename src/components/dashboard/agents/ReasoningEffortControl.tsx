'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/motion/button';
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph';
import { RangeSlider } from '@/components/motion/range-slider';
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/agents/constants';

const LABELS = {
  default: 'reasoningEffortDefault',
  minimal: 'reasoningEffortMinimal',
  low: 'reasoningEffortLow',
  medium: 'reasoningEffortMedium',
  high: 'reasoningEffortHigh',
  xhigh: 'reasoningEffortXHigh',
  max: 'reasoningEffortMax',
} as const;
const levels = REASONING_EFFORTS.slice(1);

export function ReasoningEffortControl({ value, disabled, onChange }: {
  value: ReasoningEffort;
  disabled?: boolean;
  onChange: (value: ReasoningEffort) => void;
}) {
  const t = useTranslations('console.agents');
  return <MorphPopover>
    <MorphPopoverTrigger>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`${t('reasoningEffort')}: ${t(LABELS[value])}`} className="h-8 shrink-0 gap-1 text-xs">
        {t('reasoningEffort')}: {t(LABELS[value])}
      </Button>
    </MorphPopoverTrigger>
    <MorphPopoverContent side="top" align="start" className="w-64 max-w-[calc(100vw-1rem)] p-4">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{t('reasoningEffort')}: {t(LABELS[value])}</span>
        <button type="button" disabled={disabled} onClick={() => onChange('default')} aria-pressed={value === 'default'} className="rounded px-1.5 py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('reasoningEffortDefault')}
        </button>
      </div>
      <RangeSlider min={0} max={levels.length - 1} step={1} disabled={disabled}
        value={value === 'default' ? 2 : levels.indexOf(value)}
        onValueChange={(index) => onChange(levels[index])}
        aria-label={t('reasoningEffort')} formatValueText={(index) => t(LABELS[value === 'default' ? 'default' : levels[index]])}
        className="mt-3" />
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{t('reasoningEffortFaster')}</span><span>{t('reasoningEffortSmarter')}</span>
      </div>
    </MorphPopoverContent>
  </MorphPopover>;
}
