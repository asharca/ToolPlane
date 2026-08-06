'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Poll server-owned runtime state until the caller observes readiness.
export function ProvisioningRefresher({
  active,
  deploymentId,
  initialStatus,
}: {
  active: boolean;
  deploymentId?: string;
  initialStatus?: string;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    // Collection pages and sandbox views do not have a single runtime API to
    // query, so retain their lightweight server refresh behavior.
    if (!deploymentId) {
      const timer = window.setInterval(() => router.refresh(), 2500);
      return () => window.clearInterval(timer);
    }

    let cancelled = false;
    let timer: number | undefined;
    let observedStatus = initialStatus ?? 'provisioning';
    const scheduleNext = (status: string) => {
      if (cancelled || (status !== 'provisioning' && status !== 'running')) return;
      // Provisioning benefits from a fast progress cadence. Once ready, keep a
      // lighter heartbeat so a later supervisor crash still updates detail-page
      // controls without requiring the Logs tab to be open.
      const intervalMs = status === 'provisioning' ? 1000 : 3000;
      timer = window.setTimeout(() => void poll(), intervalMs);
    };
    async function poll() {
      try {
        const response = await fetch(
          `/api/v1/mcp/${deploymentId}/runtime?cursor=0&limit=1`,
          { cache: 'no-store' },
        );
        if (cancelled) return;
        if (!response.ok) {
          scheduleNext(observedStatus);
          return;
        }
        const payload = await response.json() as { snapshot?: { status?: string } | null };
        // A missing runtime record means there is no supervised process to
        // provision, which matches effectiveStatus's stopped fallback.
        const status = payload.snapshot?.status ?? 'stopped';
        if (status !== observedStatus) {
          observedStatus = status;
          router.refresh();
        }
        scheduleNext(status);
      } catch {
        // The next interval is enough to recover from a transient request
        // failure; avoid forcing full-page refreshes while the API is down.
        scheduleNext(observedStatus);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, deploymentId, initialStatus, router]);
  return null;
}
