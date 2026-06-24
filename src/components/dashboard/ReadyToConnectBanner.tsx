'use client';

import { useState } from 'react';
import { ArrowRight, X } from 'lucide-react';

export function ReadyToConnectBanner({ noun }: { noun: 'server' | 'toolkit' }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-100 bg-sky-50 px-4 py-3 dark:border-sky-500/20 dark:bg-sky-500/10">
      <div className="flex items-center gap-3">
        <span className="size-2.5 shrink-0 rounded-full bg-sky-500" />
        <p className="text-sm text-zinc-700 dark:text-zinc-200">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            Ready to connect
          </span>{' '}
          Install this {noun} in Claude Code, Desktop, Cursor, or any MCP client.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          <ArrowRight className="size-3.5" />
          Connect with…
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-sky-100 hover:text-zinc-900 dark:hover:bg-sky-500/20 dark:hover:text-zinc-100"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
