'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

type Status = {
  connected: boolean;
  connectedAt: string | null;
  lastSeen: string | null;
  root: string | null;
  platform: string | null;
  arch: string | null;
  shell: string | null;
};

function runtimeSignature(status: Status): string {
  return [status.connected, status.connectedAt, status.root, status.platform, status.arch, status.shell].join('|');
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function SandboxConnectorStatus({
  workspace,
  sandboxId,
  initialStatus,
  className,
}: {
  workspace: string;
  sandboxId: string;
  initialStatus?: Status;
  className?: string;
}) {
  const [status, setStatus] = useState<Status | null>(initialStatus ?? null);
  const lastRuntimeRef = useRef(initialStatus ? runtimeSignature(initialStatus) : null);
  const t = useTranslations('console.sandboxes');
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function commitStatus(next: Status) {
      if (cancelled) return;
      setStatus(next);
      const signature = runtimeSignature(next);
      if (lastRuntimeRef.current !== null && signature !== lastRuntimeRef.current) {
        router.refresh();
      }
      lastRuntimeRef.current = signature;
    }

    async function check() {
      try {
        const res = await fetch(
          `/api/v1/workspaces/${encodeURIComponent(workspace)}/sandboxes/${encodeURIComponent(sandboxId)}/connector-status`,
          { cache: 'no-store' },
        );
        const body = (await res.json()) as Status;
        commitStatus(body);
      } catch {
        commitStatus({
          connected: false,
          connectedAt: null,
          lastSeen: null,
          root: null,
          platform: null,
          arch: null,
          shell: null,
        });
      }
      if (!cancelled) timer = setTimeout(check, 2500);
    }

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router, sandboxId, workspace]);

  const connected = Boolean(status?.connected);
  const label = connected
    ? t('connectorConnected')
    : status ? t('waitingForConnector') : t('checkingConnector');
  const details = [
    [status?.platform, status?.arch].filter(Boolean).join('/'),
    status?.shell,
    status?.root,
  ].filter(Boolean).join(' · ');

  return (
    <span
      aria-live="polite"
      title={details || undefined}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium',
        connected
          ? 'border-brand/40 bg-brand-soft text-accent-foreground'
          : 'border-border bg-muted/60 text-muted-foreground',
        className,
      )}
    >
      <span className={cx('size-1.5 rounded-full', connected ? 'bg-brand' : 'bg-muted-foreground/70')} />
      {label}
    </span>
  );
}
