'use client';

import { useTranslations } from 'next-intl';
import { FormSelect } from '@/components/ui/FormSelect';
import { type ReasoningEffort } from '@/lib/agents/constants';

const LABELS = {
  default: 'reasoningEffortDefault',
  minimal: 'reasoningEffortMinimal',
  low: 'reasoningEffortLow',
  medium: 'reasoningEffortMedium',
  high: 'reasoningEffortHigh',
  xhigh: 'reasoningEffortXHigh',
  max: 'reasoningEffortMax',
} as const;

export function ReasoningEffortControl({ value, disabled, onChange }: {
  value: ReasoningEffort;
  disabled?: boolean;
  onChange: (value: ReasoningEffort) => void;
}) {
  const t = useTranslations('console.agents');
  return <FormSelect label={t('reasoningEffort')} value={value} disabled={disabled}
    options={(Object.keys(LABELS) as ReasoningEffort[]).map((effort) => ({ value: effort, label: t(LABELS[effort]) }))}
    onValueChange={(next) => { if (next in LABELS) onChange(next as ReasoningEffort); }} />;
}
