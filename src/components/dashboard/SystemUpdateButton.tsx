'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Popover } from 'radix-ui';

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

type UiState = 'idle' | 'checking' | 'updating' | 'applying' | 'restarting' | 'error';

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

export function SystemUpdateButton({ canInstall }: { canInstall: boolean }) {
  const t = useTranslations('console.systemUpdate');
  const settingsT = useTranslations('console.settings');
  const sidebarT = useTranslations('console.sidebar');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [uiState, setUiState] = useState<UiState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const restartPollRef = useRef<AbortController | null>(null);
  const checkedOnMountRef = useRef(false);

  const refresh = useCallback(async () => {
    setUiState((state) => (
      state === 'updating' || state === 'applying' || state === 'restarting' ? state : 'checking'
    ));
    setStatus(null);
    setMessage(null);
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
    return () => restartPollRef.current?.abort();
  }, []);

  useEffect(() => {
    if (checkedOnMountRef.current) return;
    checkedOnMountRef.current = true;
    void refresh();
  }, [refresh]);

  const waitForRestart = useCallback(
    async (latestVersion: string | null, previousRuntimeId: string | null, requestError?: string) => {
      restartPollRef.current?.abort();
      const controller = new AbortController();
      restartPollRef.current = controller;
      const outcome = await waitForSystemUpdateReady(latestVersion, {
        previousRuntimeId,
        signal: controller.signal,
        onProgress(updateJob) {
          if (updateJob?.status === 'downloading') {
            setUiState('updating');
            setMessage(updateJob.message ?? t('updating'));
          } else if (updateJob?.status === 'applying') {
            setUiState('applying');
            setMessage(updateJob.message ?? t('applying'));
          } else if (updateJob?.status === 'restarting') {
            setUiState('restarting');
            setMessage(updateJob.message ?? t('restarting'));
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
    if (
      !status?.canUpdate
      || status.updateAvailable !== true
      || uiState === 'updating'
      || uiState === 'applying'
      || uiState === 'restarting'
    ) return;
    if (!window.confirm(t('confirmUpdate', { version: status.latestVersion ?? '' }))) return;
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
        setMessage(result.status === 'restarting' ? t('restarting') : t('updating'));
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

  const busy = uiState === 'checking' || uiState === 'updating' || uiState === 'applying' || uiState === 'restarting';
  let label = t('checkAndUpdate');
  if (uiState === 'checking') label = t('checking');
  else if (uiState === 'updating') label = t('updating');
  else if (uiState === 'applying') label = t('applying');
  else if (uiState === 'restarting') label = t('restartingShort');
  else if (uiState === 'error') label = t('failed');
  else if (status && !status.canUpdate) label = t('unavailable');
  else if (status?.updateAvailable === false) label = t('upToDate');
  else if (status?.updateAvailable === true) label = t('updateAvailable');

  const versionDetail = systemUpdateVersionDetail(
    status?.currentVersion,
    status?.latestVersion,
  );
  const detail = message || status?.reason || null;
  const showUpdate = canInstall && status?.canUpdate === true && status.updateAvailable === true;
  const hasUpdate = status?.updateAvailable === true;
  const triggerLabel = hasUpdate
    ? `${settingsT('systemUpdate')}: ${t('updateAvailable')}`
    : settingsT('systemUpdate');
  const activeStage = uiState === 'updating' ? 0 : uiState === 'applying' ? 1 : uiState === 'restarting' ? 2 : -1;
  const stages = [
    t('downloading'),
    t('applying'),
    t('restartingShort'),
  ];

  return (
    <Popover.Root onOpenChange={(open) => {
      if (open && !busy) void refresh();
    }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
          className="ui-button-ghost ui-icon-button"
        >
          <span className="relative flex size-4">
            {busy ? <RefreshCw className="size-4 animate-spin" /> : <Download className="size-4" />}
            {hasUpdate ? <span aria-hidden="true" className="absolute -right-1 -top-1 size-2 rounded-full bg-amber-500" /> : null}
          </span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={settingsT('systemUpdate')}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] space-y-4 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none"
        >
          <div className="flex items-start gap-3">
            <div aria-live="polite" className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{settingsT('systemUpdate')}</p>
              <p role={uiState === 'error' ? 'alert' : 'status'} className="mt-1 text-sm font-medium text-foreground">{label}</p>
              {detail ? (
                <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground" title={detail}>
                  {detail}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={busy}
              aria-label={t('checkAndUpdate')}
              title={t('checkAndUpdate')}
              className="ui-button-ghost ui-icon-button shrink-0 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {versionDetail ? (
            <div className="flex items-center justify-between gap-3 border-y border-border py-2 text-xs">
              <span className="text-muted-foreground">{sidebarT('version')}</span>
              <span className="truncate font-medium text-foreground" title={versionDetail}>{versionDetail}</span>
            </div>
          ) : null}

          {status?.releaseName ? (
            status.releaseUrl ? (
              <a
                href={status.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="truncate">{status.releaseName}</span>
                <ExternalLink className="size-3.5 shrink-0" />
              </a>
            ) : (
              <p className="truncate text-xs text-muted-foreground">{status.releaseName}</p>
            )
          ) : null}

          {activeStage >= 0 ? (
            <ol aria-label={t('updateProgress')} className="flex flex-col gap-2">
              {stages.map((stage, index) => {
                const complete = index < activeStage;
                const active = index === activeStage;
                return (
                  <li key={stage} className={`flex items-center gap-2 text-xs ${
                    active ? 'font-medium text-foreground' : complete ? 'text-foreground' : 'text-muted-foreground'
                  }`}>
                    <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
                      active ? 'bg-brand text-brand-foreground' : complete ? 'bg-brand-soft text-brand' : 'bg-muted text-muted-foreground'
                    }`}>
                      {complete ? <Check className="size-3" /> : active ? <RefreshCw className="size-3 animate-spin" /> : index + 1}
                    </span>
                    <span>{stage}</span>
                  </li>
                );
              })}
            </ol>
          ) : null}

          {showUpdate ? (
            <button
              type="button"
              onClick={runUpdate}
              disabled={uiState === 'updating' || uiState === 'applying' || uiState === 'restarting'}
              className="ui-button-primary ui-button-sm w-full disabled:cursor-wait disabled:opacity-70"
            >
              {uiState === 'updating' || uiState === 'applying' || uiState === 'restarting'
                ? <RefreshCw className="size-3.5 animate-spin" />
                : <Download className="size-3.5" />}
              {uiState === 'updating'
                ? t('updating')
                : uiState === 'applying'
                  ? t('applying')
                  : uiState === 'restarting'
                    ? t('restartingShort')
                    : t('updateNow')}
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
