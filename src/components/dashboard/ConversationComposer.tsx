'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, X } from 'lucide-react';
import { Button } from '@/components/motion/button';
import { Tooltip } from '@/components/motion/tooltip';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import type { ContextUsageSnapshot } from '@/lib/context-usage';

export function ConversationContextUsage({ busy = false, usage }: { busy?: boolean; usage: ContextUsageSnapshot | null }) {
  const t = useTranslations('console.agents');
  if (!usage) return null;
  const percentage = Math.round(Math.min(100, Math.max(0, usage.usedTokens / usage.maxTokens * 100)));
  return <Tooltip content={<div className="space-y-2"><p>{t('contextUsage')}</p><p>{usage.estimated ? '≈ ' : ''}{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} ({percentage}%)</p><p>{usage.modelName}</p>{usage.estimated ? <p>{t('contextUsageEstimated')}</p> : null}</div>}>
    <span role="meter" tabIndex={0} aria-label={t('contextUsage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-busy={busy || undefined}>
      <AnimatedBadge status={busy ? 'loading' : percentage >= 90 ? 'danger' : percentage >= 75 ? 'warning' : 'neutral'}>{percentage}%</AnimatedBadge>
    </span>
  </Tooltip>;
}

/** Local file previews keep object URLs scoped to the actual attachment lifetime. */
export function ConversationFilePreview({ file, name, url, mimeType, progress, onRemove, removeLabel }: {
  file?: File; name: string; url?: string; mimeType?: string; progress?: number;
  onRemove?: () => void; removeLabel?: string;
}) {
  const [localUrl, setLocalUrl] = useState<string>();
  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) return;
    const objectUrl = URL.createObjectURL(file);
    // Object URL creation is an external resource synchronization.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const source = file ? localUrl : url;
  const image = (file?.type ?? mimeType)?.startsWith('image/');
  return <div className="flex max-w-full items-center gap-2">
    {image && source ? <img src={source} alt={name} className="max-h-32 max-w-48 object-contain" /> : <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
    {url ? <a href={url} download={name} className="min-w-0 truncate text-sm underline underline-offset-4">{name}</a> : <span className="min-w-0 truncate text-sm">{name}</span>}
    {progress !== undefined ? <span role="status" className="text-xs text-muted-foreground">{Math.round(progress * 100)}%</span> : null}
    {onRemove ? <Button type="button" variant="ghost" size="icon" aria-label={removeLabel} onClick={onRemove}><X className="size-4" /></Button> : null}
  </div>;
}
