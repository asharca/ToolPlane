"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Sandbox state can change through Agent work or idle shutdown, not just this UI.
export function SandboxStatusRefresher({
  transitioning = false,
}: {
  transitioning?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    let timer: number | undefined;
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      // Focus and visibility events commonly arrive together.
      if (now - lastRefresh < 2000) return;
      lastRefresh = now;
      router.refresh();
    };
    const schedule = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      timer = window.setInterval(refresh, transitioning ? 3000 : 15000);
    };
    const visibility = () => {
      refresh();
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", refresh);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", refresh);
    };
  }, [router, transitioning]);

  return null;
}
