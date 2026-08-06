'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

export type DeploymentRuntimeSnapshotView = {
  status: string;
  phase: string;
  generation: string;
  containerName?: string;
  containerState?: string;
  imageState?: string;
  startedAt?: string;
  lastActivityAt?: string;
  updatedAt?: string;
};

type DeploymentRuntimeLogChunkView = {
  generation: string | null;
  cursor: number;
  nextCursor: number;
  reset: boolean;
  text: string;
  truncated?: boolean;
};

type RuntimeResponse = {
  snapshot: DeploymentRuntimeSnapshotView | null;
  logs: DeploymentRuntimeLogChunkView;
};

const TERMINAL_STATUSES = new Set(['stopped', 'error']);
// Keep the browser-side tail no larger than the supervisor's retained stderr
// file. This prevents a long-running Logs tab from growing without bound.
const MAX_CLIENT_LOG_BYTES = 512 * 1024;

type RuntimeLogView = {
  text: string;
  truncated: boolean;
};

function isTerminalStatus(status: string | null | undefined): boolean {
  return !status || TERMINAL_STATUSES.has(status);
}

function readablePhase(phase: string | undefined): string {
  if (!phase) return '—';
  return phase.replaceAll(/[_-]+/g, ' ');
}

function keepRecentLogText(value: string): { text: string; trimmed: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_CLIENT_LOG_BYTES) {
    return { text: value, trimmed: false };
  }

  // Start at a UTF-8 code-point boundary so trimming cannot introduce a
  // replacement character at the beginning of the rendered log tail.
  let start = bytes.byteLength - MAX_CLIENT_LOG_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return { text: new TextDecoder().decode(bytes.subarray(start)), trimmed: true };
}

export function ContainerLogs({
  deploymentId,
  initialSnapshot,
  initialStatus,
  title,
  refreshLabel,
  emptyLabel,
  unavailableLabel,
  statusLabel,
  phaseLabel,
  imageStateLabel,
  containerStateLabel,
  syncErrorLabel,
  truncatedLabel,
}: {
  deploymentId: string;
  initialSnapshot: DeploymentRuntimeSnapshotView | null;
  initialStatus: string;
  title: string;
  refreshLabel: string;
  emptyLabel: string;
  unavailableLabel: string;
  statusLabel: string;
  phaseLabel: string;
  imageStateLabel: string;
  containerStateLabel: string;
  syncErrorLabel: string;
  truncatedLabel: string;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<DeploymentRuntimeSnapshotView | null>(initialSnapshot);
  const [runtimeStatus, setRuntimeStatus] = useState(initialSnapshot?.status ?? initialStatus);
  const [logView, setLogView] = useState<RuntimeLogView>({ text: '', truncated: false });
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const generationRef = useRef<string | null>(initialSnapshot?.generation ?? null);
  const cursorRef = useRef(0);
  const statusRef = useRef(initialSnapshot?.status ?? initialStatus);
  const inFlightRef = useRef(false);
  const hasLogs = Boolean(logView.text.trim());
  const currentStatus = runtimeStatus;

  // The endpoint only exposes supervisor-captured stderr. Docker stdout is MCP
  // protocol traffic and must never be rendered in the dashboard.
  const sync = useCallback(async (manual = false) => {
    if (inFlightRef.current) {
      if (manual) router.refresh();
      return;
    }

    inFlightRef.current = true;
    if (manual) setRefreshing(true);
    try {
      const query = new URLSearchParams({
        cursor: String(cursorRef.current),
        limit: '16384',
      });
      if (generationRef.current) query.set('generation', generationRef.current);

      const response = await fetch(`/api/v1/mcp/${deploymentId}/runtime?${query}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`runtime sync failed (${response.status})`);
      const data = await response.json() as RuntimeResponse;
      const chunk = data.logs;
      const previousGeneration = generationRef.current;
      const generationChanged = Boolean(
        previousGeneration && chunk.generation && previousGeneration !== chunk.generation,
      );
      const shouldReset = chunk.reset || generationChanged;

      setLogView((previous) => {
        const combined = shouldReset ? chunk.text : `${previous.text}${chunk.text}`;
        const bounded = keepRecentLogText(combined);
        return {
          text: bounded.text,
          truncated: (shouldReset ? false : previous.truncated)
            || Boolean(chunk.truncated)
            || bounded.trimmed,
        };
      });
      generationRef.current = chunk.generation;
      cursorRef.current = chunk.nextCursor;
      setSnapshot(data.snapshot);
      setSyncError(false);

      const nextStatus = data.snapshot?.status ?? 'stopped';
      const previousStatus = statusRef.current;
      statusRef.current = nextStatus;
      setRuntimeStatus(nextStatus);
      if (previousStatus !== nextStatus) {
        // Refresh server-rendered controls and the header as soon as the
        // supervisor reports a lifecycle status transition.
        router.refresh();
      }
    } catch {
      setSyncError(true);
    } finally {
      inFlightRef.current = false;
      if (manual) setRefreshing(false);
    }
  }, [deploymentId, router]);

  useEffect(() => {
    // A Logs visit always gets one fresh chunk. Provisioning emits progress at
    // one-second intervals; a healthy runtime keeps a lower-frequency tail so
    // later stderr is still visible without keeping a hot polling loop alive.
    const firstPoll = window.setTimeout(() => void sync(), 0);
    if (isTerminalStatus(currentStatus)) {
      return () => window.clearTimeout(firstPoll);
    }
    const intervalMs = currentStatus === 'provisioning' ? 1000 : 3000;
    const timer = window.setInterval(() => void sync(), intervalMs);
    return () => {
      window.clearTimeout(firstPoll);
      window.clearInterval(timer);
    };
  }, [currentStatus, sync]);

  async function refresh() {
    await sync(true);
    router.refresh();
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1">
              <dt>{statusLabel}:</dt>
              <dd className="font-medium text-foreground">{currentStatus}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{phaseLabel}:</dt>
              <dd className="font-medium text-foreground">{readablePhase(snapshot?.phase)}</dd>
            </div>
            {snapshot?.imageState ? (
              <div className="flex gap-1">
                <dt>{imageStateLabel}:</dt>
                <dd>{snapshot.imageState}</dd>
              </div>
            ) : null}
            {snapshot?.containerState ? (
              <div className="flex gap-1">
                <dt>{containerStateLabel}:</dt>
                <dd>{snapshot.containerState}</dd>
              </div>
            ) : null}
          </dl>
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
          {logView.text}
        </pre>
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-700">
          <p className="text-sm text-muted-foreground">
            {snapshot ? emptyLabel : unavailableLabel}
          </p>
        </div>
      )}

      {logView.truncated ? <p className="text-xs text-muted-foreground">{truncatedLabel}</p> : null}
      {syncError ? <p className="text-xs text-red-600 dark:text-red-400">{syncErrorLabel}</p> : null}
    </section>
  );
}
