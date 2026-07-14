'use client';

import { useTranslations } from 'next-intl';

const STYLES: Record<string, { dot: string; labelKey: string }> = {
  running: { dot: 'bg-emerald-500', labelKey: 'statusRunning' },
  error: { dot: 'bg-red-500', labelKey: 'statusError' },
  provisioning: { dot: 'bg-amber-500', labelKey: 'statusProvisioning' },
  copying: { dot: 'bg-amber-500', labelKey: 'statusCopying' },
  copy_failed: { dot: 'bg-red-500', labelKey: 'statusCopyInterrupted' },
  restoring: { dot: 'bg-amber-500', labelKey: 'statusRestoring' },
  restore_failed: { dot: 'bg-red-500', labelKey: 'statusRecoveryRequired' },
  restore_cleanup_required: { dot: 'bg-red-500', labelKey: 'statusCleanupPending' },
  deleting: { dot: 'bg-amber-500', labelKey: 'statusDeleting' },
  setup_required: { dot: 'bg-amber-500', labelKey: 'statusSetupRequired' },
  stopped: { dot: 'bg-zinc-400', labelKey: 'statusStopped' },
};

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('console.sandboxes');
  const s = STYLES[status] ?? STYLES.provisioning;
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <span className={`size-2 rounded-full ${s.dot}`} />
      {t(s.labelKey)}
    </span>
  );
}
