"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { TimeFilter } from "@/lib/observability/views/types";
import { FormSelect } from "@/components/ui/FormSelect";

const fieldClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm";

export function TimeRangePicker({ filter }: { filter: TimeFilter }) {
  const t = useTranslations("console.observability.viewer");
  const fieldId = useId();
  const [range, setRange] = useState(filter.range ?? "24h");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  useEffect(() => {
    function localInput(value?: string) {
      if (!value) return "";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "";
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
    }
    setSince(localInput(filter.since));
    setUntil(localInput(filter.until));
  }, [filter.since, filter.until]);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1 text-xs text-muted-foreground">
        <label htmlFor={fieldId}>{t("timeRange")}</label>
        <FormSelect
          id={fieldId}
          name="range"
          label={t("timeRange")}
          value={range}
          onValueChange={(value) =>
            setRange(value as NonNullable<TimeFilter["range"]>)
          }
          className="w-36"
          options={["1h", "24h", "7d", "30d", "custom"].map((value) => ({
            value,
            label: t(`ranges.${value}`),
          }))}
        />
      </div>
      {range === "custom" && (
        <>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("since")}
            <input
              type="datetime-local"
              required
              value={since}
              max={until || undefined}
              onChange={(event) => setSince(event.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("until")}
            <input
              type="datetime-local"
              required
              value={until}
              min={since || undefined}
              onChange={(event) => setUntil(event.target.value)}
              className={fieldClass}
            />
          </label>
          <input
            type="hidden"
            name="since"
            value={since ? new Date(since).toISOString() : ""}
          />
          <input
            type="hidden"
            name="until"
            value={until ? new Date(until).toISOString() : ""}
          />
        </>
      )}
    </div>
  );
}
