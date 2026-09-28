'use client';

import { useTranslations } from 'next-intl';
import { AnimatedBadge, type AnimatedBadgeStatus } from '@/components/motion/animated-badge';

const STATUS: Record<string, { status: AnimatedBadgeStatus; labelKey: string }> = {
  running: { status: 'success', labelKey: 'statusRunning' },
  error: { status: 'danger', labelKey: 'statusError' },
  provisioning: { status: 'loading', labelKey: 'statusProvisioning' },
  copying: { status: 'loading', labelKey: 'statusCopying' },
  copy_failed: { status: 'danger', labelKey: 'statusCopyInterrupted' },
  restoring: { status: 'loading', labelKey: 'statusRestoring' },
  restore_failed: { status: 'danger', labelKey: 'statusRecoveryRequired' },
  restore_cleanup_required: { status: 'danger', labelKey: 'statusCleanupPending' },
  upgrading: { status: 'loading', labelKey: 'statusUpgrading' },
  deleting: { status: 'loading', labelKey: 'statusDeleting' },
  setup_required: { status: 'warning', labelKey: 'statusSetupRequired' },
  stopped: { status: 'neutral', labelKey: 'statusStopped' },
};

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('console.sandboxes');
  const state = STATUS[status] ?? STATUS.provisioning;
  return <AnimatedBadge status={state.status} size="sm">{t(state.labelKey)}</AnimatedBadge>;
}
