'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

export const SYSTEM_UPDATE_LOCAL_STATUS_PATH = '/api/v1/admin/system/update?local=1';
const RESTART_POLL_INTERVAL_MS = 1_500;
const RESTART_TIMEOUT_MS = 15 * 60_000;

type UpdateStatus = {
  enabled: boolean;
  canUpdate: boolean;
  runtimeId: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  releaseName: string | null;
  releaseUrl: string | null;
  artifactName: string;
  reason: string | null;
};

type UpdateResult = {
  ok: boolean;
  status: 'up_to_date' | 'updating' | 'restarting' | 'disabled' | 'unavailable' | 'failed';
  runtimeId: string;
  currentVersion: string;
  latestVersion: string | null;
  artifactName: string;
  message?: string;
};

type LocalUpdateStatus = {
  runtimeId?: string;
  currentVersion: string;
  artifactName: string;
  updateJob?: {
    status: 'idle' | 'downloading' | 'applying' | 'restarting' | 'failed';
    targetVersion: string | null;
    message: string | null;
  };
};

type UpdateWaitResult =
  | { status: 'ready' }
  | { status: 'failed'; message: string }
  | { status: 'timeout' };

type UiState = 'idle' | 'checking' | 'updating' | 'restarting' | 'error';

function versionsMatch(current: string, expected: string | null): boolean {
  return Boolean(expected && current.trim() === expected.trim());
}

export function systemUpdateVersionDetail(
  currentVersion: string | null | undefined,
  latestVersion: string | null | undefined,
): string | null {
  if (!currentVersion) return null;
  if (!latestVersion || versionsMatch(currentVersion, latestVersion)) return currentVersion;
  return `${currentVersion} → ${latestVersion}`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export async function waitForSystemUpdateReady(
  expectedVersion: string | null,
  options: {
    previousRuntimeId?: string | null;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (status: LocalUpdateStatus['updateJob']) => void;
    fallbackFailureMessage?: string;
    requestNotStartedMessage?: string;
  } = {},
): Promise<UpdateWaitResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? RESTART_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? RESTART_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { status: 'timeout' };
    try {
      const response = await fetchImpl(SYSTEM_UPDATE_LOCAL_STATUS_PATH, {
        cache: 'no-store',
        signal: options.signal,
      });
      if (response.ok) {
        const data = (await response.json()) as LocalUpdateStatus;
        options.onProgress?.(data.updateJob);
        const versionReady = expectedVersion
          ? versionsMatch(data.currentVersion, expectedVersion)
          : Boolean(options.previousRuntimeId);
        const runtimeReady = options.previousRuntimeId
          ? data.runtimeId !== options.previousRuntimeId
          : true;
        if (versionReady && runtimeReady) {
          return { status: 'ready' };
        }
        if (data.updateJob?.status === 'failed') {
          return {
            status: 'failed',
            message: data.updateJob.message ?? options.fallbackFailureMessage ?? 'System update failed.',
          };
        }
        if (data.updateJob?.status === 'idle') {
          return {
            status: 'failed',
            message: options.requestNotStartedMessage ?? 'The update request did not start.',
          };
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return { status: 'timeout' };
    }
    await wait(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal).catch(() => undefined);
  }

  return { status: 'timeout' };
}

export function SystemUpdateButton() {
  const t = useTranslations('console.systemUpdate');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [uiState, setUiState] = useState<UiState>('checking');
  const [message, setMessage] = useState<string | null>(null);
  const restartPollRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setUiState((state) => (state === 'updating' || state === 'restarting' ? state : 'checking'));
    try {
      const response = await fetch('/api/v1/admin/system/update', { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = (await response.json()) as UpdateStatus;
      setStatus(data);
      setMessage(data.reason);
      setUiState('idle');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setUiState('error');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      try {
        const response = await fetch('/api/v1/admin/system/update', { cache: 'no-store' });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = (await response.json()) as UpdateStatus;
        if (cancelled) return;
        setStatus(data);
        setMessage(data.reason);
        setUiState('idle');
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setUiState('error');
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
      restartPollRef.current?.abort();
    };
  }, []);

  const waitForRestart = useCallback(
    async (latestVersion: string | null, previousRuntimeId: string | null, requestError?: string) => {
      restartPollRef.current?.abort();
      const controller = new AbortController();
      restartPollRef.current = controller;
      const outcome = await waitForSystemUpdateReady(latestVersion, {
        previousRuntimeId,
        signal: controller.signal,
        onProgress(updateJob) {
          if (updateJob?.status === 'restarting') {
            setUiState('restarting');
            setMessage(t('restarting'));
          }
        },
        fallbackFailureMessage: t('systemUpdateFailed'),
        requestNotStartedMessage: t('updateDidNotStart'),
      });
      if (controller.signal.aborted) return;
      if (outcome.status === 'ready') {
        window.location.reload();
        return;
      }
      setMessage(outcome.status === 'failed' ? outcome.message : requestError ?? t('restartTimeout'));
      setUiState('error');
    },
    [t],
  );

  const runUpdate = async () => {
    if (uiState === 'updating' || uiState === 'restarting') return;
    setUiState('updating');
    setMessage(null);
    const targetVersion = status?.latestVersion ?? null;
    const previousRuntimeId = status?.runtimeId ?? null;
    try {
      const response = await fetch('/api/v1/admin/system/update', {
        method: 'POST',
      });
      const result = (await response.json().catch(() => null)) as UpdateResult | null;
      if (!response.ok) {
        if (result && !result.ok) {
          setMessage(result.message ?? `${response.status} ${response.statusText}`);
          setUiState('error');
          return;
        }
        void waitForRestart(targetVersion, previousRuntimeId, `${response.status} ${response.statusText}`);
        return;
      }
      if (!result?.ok) {
        void waitForRestart(targetVersion, previousRuntimeId, t('invalidUpdateResponse'));
        return;
      }
      if (result.status === 'updating' || result.status === 'restarting') {
        setUiState(result.status === 'restarting' ? 'restarting' : 'updating');
        setMessage(result.status === 'restarting' ? t('restarting') : null);
        void waitForRestart(
          result.latestVersion ?? targetVersion,
          result.runtimeId ?? previousRuntimeId,
        );
        return;
      }
      setUiState('idle');
      setMessage(t('upToDate'));
      await refresh();
    } catch (error) {
      // The reverse proxy can drop this request while the app is replacing its
      // runtime or restarting. Poll the authenticated local status endpoint to
      // distinguish that expected outage from a real update failure.
      void waitForRestart(
        targetVersion,
        previousRuntimeId,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const disabled = !status?.canUpdate || uiState === 'checking' || uiState === 'updating' || uiState === 'restarting';
  const Icon = useMemo(() => {
    if (uiState === 'error') return TriangleAlert;
    if (status?.updateAvailable === false) return CheckCircle2;
    if (uiState === 'checking' || uiState === 'updating' || uiState === 'restarting') return RefreshCw;
    return Download;
  }, [status?.updateAvailable, uiState]);

  const label = useMemo(() => {
    if (uiState === 'checking') return t('checking');
    if (uiState === 'updating') return t('updating');
    if (uiState === 'restarting') return t('restartingShort');
    if (uiState === 'error') return t('failed');
    if (!status?.canUpdate) return t('unavailable');
    if (status.updateAvailable === false) return t('upToDate');
    if (status.updateAvailable === true) return t('updateAvailable');
    return t('checkAndUpdate');
  }, [status, t, uiState]);

  const versionDetail = systemUpdateVersionDetail(
    status?.currentVersion,
    status?.latestVersion,
  );
  const detail = message || versionDetail || status?.artifactName || t('targetReleaseUnknown');

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={runUpdate}
        disabled={disabled}
        title={detail}
        className="group flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background/60 px-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
      >
        <Icon
          className={`size-3.5 shrink-0 ${
            uiState === 'checking' || uiState === 'updating' || uiState === 'restarting' ? 'animate-spin' : ''
          }`}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      <p className="mt-1 truncate px-1 text-[10px] leading-4 text-muted-foreground" title={detail}>
        {detail}
      </p>
    </div>
  );
}
