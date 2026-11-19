"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/client/api";

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
    let observedStatus = initialStatus ?? "provisioning";
    const scheduleNext = (status: string) => {
      if (cancelled || (status !== "provisioning" && status !== "running"))
        return;
      // Provisioning benefits from a fast progress cadence. Once ready, keep a
      // lighter heartbeat so a later supervisor crash still updates detail-page
      // controls without requiring the Logs tab to be open.
      const intervalMs = status === "provisioning" ? 1000 : 3000;
      timer = window.setTimeout(() => void poll(), intervalMs);
    };
    async function poll() {
      const result = await apiRequest<{
        snapshot?: { status?: string } | null;
      }>(`/api/v1/mcp/${deploymentId}/runtime?cursor=0&limit=1`, {
        cache: "no-store",
      });
      if (cancelled) return;
      // A failed poll waits for the next interval; forcing full-page refreshes
      // while the API is down would not help it recover.
      if (!result.ok) {
        scheduleNext(observedStatus);
        return;
      }
      // A missing runtime record means there is no supervised process to
      // provision, which matches effectiveStatus's stopped fallback.
      const status = result.data?.snapshot?.status ?? "stopped";
      if (status !== observedStatus) {
        observedStatus = status;
        router.refresh();
      }
      scheduleNext(status);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, deploymentId, initialStatus, router]);
  return null;
}
