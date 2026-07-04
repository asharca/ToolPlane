'use client';

import { useEffect, useState } from 'react';

type Status = {
  connected: boolean;
  lastSeen: string | null;
  root: string | null;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function SandboxConnectorStatus({
  workspace,
  sandboxId,
  className,
}: {
  workspace: string;
  sandboxId: string;
  className?: string;
}) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check() {
      try {
        const res = await fetch(
          `/api/v1/workspaces/${encodeURIComponent(workspace)}/sandboxes/${encodeURIComponent(sandboxId)}/connector-status`,
          { cache: 'no-store' },
        );
        const body = (await res.json()) as Status;
        if (!cancelled) setStatus(body);
      } catch {
        if (!cancelled) setStatus({ connected: false, lastSeen: null, root: null });
      }
      if (!cancelled) timer = setTimeout(check, 2500);
    }

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sandboxId, workspace]);

  const connected = Boolean(status?.connected);
  const label = connected ? 'Connector connected' : status ? 'Waiting for connector' : 'Checking connector';

  return (
    <span
      aria-live="polite"
      title={status?.root ? `Root: ${status.root}` : undefined}
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
