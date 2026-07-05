'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

type UpdateStatus = {
  enabled: boolean;
  canUpdate: boolean;
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
  status: 'up_to_date' | 'restarting' | 'disabled' | 'unavailable' | 'failed';
  currentVersion: string;
  latestVersion: string | null;
  artifactName: string;
  message?: string;
};

type UiState = 'idle' | 'checking' | 'updating' | 'restarting' | 'error';

export function SystemUpdateButton() {
  const t = useTranslations('console.systemUpdate');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [uiState, setUiState] = useState<UiState>('checking');
  const [message, setMessage] = useState<string | null>(null);

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
    };
  }, []);

  const runUpdate = async () => {
    if (uiState === 'updating' || uiState === 'restarting') return;
    setUiState('updating');
    setMessage(null);
    try {
      const response = await fetch('/api/v1/admin/system/update', {
        method: 'POST',
      });
      const result = (await response.json()) as UpdateResult;
      if (!response.ok || !result.ok) {
        throw new Error(result.message ?? `${response.status} ${response.statusText}`);
      }
      if (result.status === 'restarting') {
        setUiState('restarting');
        setMessage(result.message ?? t('restarting'));
        return;
      }
      setUiState('idle');
      setMessage(t('upToDate'));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setUiState('error');
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

  const versionDetail =
    status?.latestVersion && status.currentVersion
      ? `${status.currentVersion} -> ${status.latestVersion}`
      : status?.currentVersion
        ? status.currentVersion
        : null;
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
