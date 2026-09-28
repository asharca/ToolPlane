'use client';
import { Button } from '@/components/motion/button';


import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { ConnectDialog } from './ConnectDialog';

export function ReadyToConnectBanner({
  noun,
  endpoint,
  name,
  status,
}: {
  noun: 'server' | 'toolkit';
  endpoint: string;
  name: string;
  status: string;
}) {
  const t = useTranslations('console.mcp');
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || status !== 'running') return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 border-border bg-card">
      <div className="flex items-center gap-3">
        <span className="size-2.5 shrink-0 rounded-full bg-primary" />
        <p className="text-sm text-foreground dark:text-foreground">
          <span className="font-semibold text-foreground dark:text-foreground">
            {t('readyToConnect')}
          </span>{' '}
          {t(noun === 'server' ? 'installServerInMcpClient' : 'installToolkitInMcpClient')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <ConnectDialog endpoint={endpoint} name={name} variant="banner" />
        <Button type="button" aria-label={t('dismiss')} onClick={() => setDismissed(true)} variant="ghost" size="icon" className="inline-flex items-center justify-center"><X className="size-4" /></Button>
      </div>
    </div>
  );
}
