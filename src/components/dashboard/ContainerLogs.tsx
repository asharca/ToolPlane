'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type ContainerLogView = {
  containerName: string;
  text: string;
  source: 'docker' | 'captured' | 'none';
  error: string | null;
};

export function ContainerLogs({
  logs,
  title,
  refreshLabel,
  dockerSourceLabel,
  capturedSourceLabel,
  emptyLabel,
  fallbackLabel,
}: {
  logs: ContainerLogView;
  title: string;
  refreshLabel: string;
  dockerSourceLabel: string;
  capturedSourceLabel: string;
  emptyLabel: string;
  fallbackLabel: string;
}) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const hasLogs = Boolean(logs.text.trim());
  const sourceLabel = logs.source === 'captured' ? capturedSourceLabel : dockerSourceLabel;

  function refresh() {
    setRefreshing(true);
    router.refresh();
    window.setTimeout(() => setRefreshing(false), 700);
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            <code className="font-mono">{logs.containerName}</code>
            {logs.source !== 'none' ? <span> · {sourceLabel}</span> : null}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="ui-button-secondary h-8 text-xs"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshLabel}
        </button>
      </div>

      {hasLogs ? (
        <pre className="max-h-[32rem] overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-200 dark:border-zinc-800">
          {logs.text}
        </pre>
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-700">
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        </div>
      )}

      {logs.source === 'captured' ? (
        <p className="text-xs text-muted-foreground">{fallbackLabel}</p>
      ) : null}
    </section>
  );
}
