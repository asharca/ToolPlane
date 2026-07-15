'use client';

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
      <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/20 p-1">
        {options.map((option) => {
          const Icon = option.icon;
          const active = value === option.value;
          return (
            <label
              key={option.value}
              className={`flex min-h-14 cursor-pointer items-center gap-2 rounded px-3 py-2 transition-colors ${
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
              } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="network"
                value={option.value}
                checked={active}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs leading-4 text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p id={descriptionId} className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {t('networkModeHint')}
      </p>
      {value === 'none' && warnAboutPackageInstall ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('networkNonePackageWarning')}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
