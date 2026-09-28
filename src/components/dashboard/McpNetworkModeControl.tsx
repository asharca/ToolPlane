'use client';
import { RadioGroup } from '@/components/motion/radio';
import { RadioGroupItem } from '@/components/motion/radio';


import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Globe2, WifiOff } from 'lucide-react';

export type McpNetworkMode = 'isolated' | 'none';

export function McpNetworkModeControl({
  value,
  onChange,
  disabled = false,
  warnAboutPackageInstall = false,
}: {
  value: McpNetworkMode;
  onChange: (value: McpNetworkMode) => void;
  disabled?: boolean;
  warnAboutPackageInstall?: boolean;
}) {
  const t = useTranslations('console.mcp');
  const descriptionId = useId();

  const options = [
    {
      value: 'isolated' as const,
      icon: Globe2,
      label: t('networkIsolated'),
      description: t('networkIsolatedDescription'),
    },
    {
      value: 'none' as const,
      icon: WifiOff,
      label: t('networkNone'),
      description: t('networkNoneDescription'),
    },
  ];

  return (
    <fieldset disabled={disabled} aria-describedby={descriptionId}>
      <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('networkMode')}
      </legend>
      <input type="hidden" name="network" value={value} disabled={disabled} />
      <RadioGroup value={value} onValueChange={(next) => onChange(next as McpNetworkMode)} orientation="horizontal">
        {options.map((option) => (<div key={option.value} className="min-w-0 flex-1 space-y-2"><RadioGroupItem value={option.value} label={option.label} disabled={disabled} /><p className="text-xs text-muted-foreground">{option.description}</p></div>))}
      </RadioGroup>
      <p id={descriptionId} className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {t('networkModeHint')}
      </p>
      <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-(--color-warning) dark:text-(--color-warning)">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('networkLoopbackProxyHint')}</span>
      </p>
      {value === 'none' && warnAboutPackageInstall ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-(--color-warning) dark:text-(--color-warning)">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('networkNonePackageWarning')}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
