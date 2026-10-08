'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/motion/button';
import { Tooltip } from '@/components/motion/tooltip';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { FileTree, FileTreeFile } from '@/components/motion/file-tree';
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
  const downloadRef = useRef<HTMLAnchorElement>(null);
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
    {image ? <>
      {source ? <img src={source} alt={name} className="max-h-32 max-w-48 object-contain" /> : null}
      {url ? <a href={url} download={name} className="min-w-0 truncate text-sm underline underline-offset-4">{name}</a> : <span className="min-w-0 truncate text-sm">{name}</span>}
    </> : <>
      <FileTree ariaLabel={name} className="min-w-0 max-w-xs flex-1" onValueChange={() => downloadRef.current?.click()}><FileTreeFile value={name} name={name} /></FileTree>
      {url ? <a ref={downloadRef} href={url} download={name} aria-label={name} className="shrink-0 rounded p-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Download className="size-4" /></a> : null}
    </>}
    {progress !== undefined ? <span role="status" className="text-xs text-muted-foreground">{Math.round(progress * 100)}%</span> : null}
    {onRemove ? <Button type="button" variant="ghost" size="icon" aria-label={removeLabel} onClick={onRemove}><X className="size-4" /></Button> : null}
  </div>;
}
