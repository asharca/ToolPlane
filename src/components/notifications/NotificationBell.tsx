"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { ButtonLink } from "@/components/motion/button/base";
import { Tooltip } from "@/components/motion/tooltip";
import { getUnreadNotificationCountAction } from "@/lib/notifications/actions";

export function NotificationBell({
  compact = false,
  workspaceSlug,
}: {
  compact?: boolean;
  workspaceSlug?: string;
}) {
  const t = useTranslations("console.notifications");
  const pathname = usePathname() ?? "";
  const [count, setCount] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const statusId = useId();
  const request = useRef<Promise<{ count: number } | { error: string }> | null>(
    null,
  );
  const href = workspaceSlug
    ? `/app/${encodeURIComponent(workspaceSlug)}/notifications`
    : "/app?view=notifications";
  const isActive = workspaceSlug
    ? pathname === href || pathname.startsWith(`${href}/`)
    : false;

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
  const tooltipLabel = unavailable
    ? `${label} — ${t("countUnavailable")}`
    : label;
  const trigger = (
    <ButtonLink
      href={href}
      variant="ghost"
      aria-label={label}
      aria-current={isActive ? "page" : undefined}
      aria-describedby={unavailable ? statusId : undefined}
      title={compact ? undefined : tooltipLabel}
      className={`relative h-9 w-full shrink-0 gap-2 rounded-lg px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isActive
          ? "bg-foreground/[0.08] font-medium hover:bg-foreground/[0.08]"
          : "font-normal hover:bg-foreground/5"
      } ${compact ? "w-9 justify-center" : "justify-start"}`}
    >
      <span
        aria-hidden="true"
        className="grid size-5 shrink-0 place-items-center"
      >
        <Bell className="size-[18px] shrink-0" />
      </span>
      {!compact && (
        <span className="min-w-0 flex-1 truncate text-left">{t("title")}</span>
      )}
      {count !== null &&
        count > 0 &&
        (compact ? (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="ml-auto inline-flex rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums"
          >
            {count > 99 ? "99+" : count}
          </span>
        ))}
    </ButtonLink>
  );

  return (
    <>
      <Tooltip
        content={tooltipLabel}
        open={compact ? undefined : false}
        side="right"
        wrapperClassName={compact ? "flex" : "flex w-full"}
      >
        {trigger}
      </Tooltip>
      <span id={statusId} role="status" className="sr-only">
        {unavailable ? t("countUnavailable") : ""}
      </span>
    </>
  );
}
