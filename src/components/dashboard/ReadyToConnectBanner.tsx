'use client';

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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-100 bg-sky-50 px-4 py-3 dark:border-sky-500/20 dark:bg-sky-500/10">
      <div className="flex items-center gap-3">
        <span className="size-2.5 shrink-0 rounded-full bg-sky-500" />
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {t('readyToConnect')}
          </span>{' '}
          {t(noun === 'server' ? 'installServerInMcpClient' : 'installToolkitInMcpClient')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <ConnectDialog endpoint={endpoint} name={name} variant="banner" />
        <button
          type="button"
          aria-label={t('dismiss')}
          onClick={() => setDismissed(true)}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sky-100 hover:text-foreground dark:hover:bg-sky-500/20"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
