"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ScrollText } from "lucide-react";
import { DashboardEmptyState } from "@/components/dashboard/DashboardUI";

export function RelativeTime({ value }: { value: string }) {
  const locale = useLocale();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const date = new Date(value);
  const seconds = now === null ? 0 : Math.round((date.getTime() - now) / 1000);
  const unit =
    Math.abs(seconds) < 60
      ? "second"
      : Math.abs(seconds) < 3600
        ? "minute"
        : Math.abs(seconds) < 86400
          ? "hour"
          : "day";
  const divisor =
    unit === "second"
      ? 1
      : unit === "minute"
        ? 60
        : unit === "hour"
          ? 3600
          : 86400;
  return (
    <time
      dateTime={value}
      title={date.toISOString()}
      className="whitespace-nowrap text-xs text-muted-foreground"
    >
      <span>
        {now === null
          ? value.replace("T", " ").slice(0, 19)
          : date.toLocaleString(locale)}
      </span>
      {now !== null && (
        <span className="block">
          {new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
            Math.round(seconds / divisor),
            unit,
          )}
        </span>
      )}
    </time>
  );
}

export function Duration({ ms }: { ms: number | null }) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      {ms === null
        ? "—"
        : ms < 1000
          ? `${Math.round(ms)} ms`
          : `${(ms / 1000).toFixed(2)} s`}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("console.observability.viewer");
  const normalized = status
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replace(/_/g, "-");
  const success = ["success", "completed"].includes(normalized);
  const error = [
    "error",
    "failed",
    "rejected",
    "canceled",
    "cancelled",
  ].includes(normalized);
  const label = t.has(`states.${normalized}`)
    ? t(`states.${normalized}`)
    : status;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${error ? "bg-destructive/10 text-destructive" : success ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}
    >
      {label}
    </span>
  );
}

export function EmptyState({ message }: { message?: string }) {
  const t = useTranslations("console.observability.viewer");
  return (
    <DashboardEmptyState icon={ScrollText} title={message ?? t("empty")} />
  );
}
