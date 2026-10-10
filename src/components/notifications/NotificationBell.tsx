"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { ButtonLink } from "@/components/motion/button/base";
import { getUnreadNotificationCountAction } from "@/lib/notifications/actions";

export function NotificationBell({
  compact = false,
  workspaceSlug,
}: {
  compact?: boolean;
  workspaceSlug?: string;
}) {
  const t = useTranslations("console.notifications");
  const [count, setCount] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const statusId = useId();
  const request = useRef<Promise<{ count: number } | { error: string }> | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    let refreshing = false;
    async function refresh() {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        const pending = request.current ?? getUnreadNotificationCountAction();
        request.current = pending;
        const result = await pending;
        if (!active) return;
        if ("count" in result) {
          setCount(result.count);
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
      } catch {
        if (active) setUnavailable(true);
      } finally {
        refreshing = false;
        request.current = null;
      }
    }
    void refresh();
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("toolplane:notifications-changed", refresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("toolplane:notifications-changed", refresh);
    };
  }, []);

  const label = count === null ? t("title") : t("bellUnread", { count });
  return (
    <>
      <ButtonLink
        href={
          workspaceSlug
            ? `/app/${encodeURIComponent(workspaceSlug)}/notifications`
            : "/app?view=notifications"
        }
        variant="ghost"
        aria-label={label}
        aria-describedby={unavailable ? statusId : undefined}
        title={unavailable ? `${label} — ${t("countUnavailable")}` : label}
        className={`relative min-h-9 shrink-0 gap-2 rounded-lg px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${compact ? "w-9 justify-center" : "justify-start"}`}
      >
        <Bell aria-hidden="true" className="size-[18px] shrink-0" />
        {!compact && (
          <span className="hidden truncate sm:inline">{t("title")}</span>
        )}
        {count !== null && count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </ButtonLink>
      <span id={statusId} role="status" className="sr-only">
        {unavailable ? t("countUnavailable") : ""}
      </span>
    </>
  );
}
