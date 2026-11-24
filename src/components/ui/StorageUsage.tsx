"use client";

import { motion, useReducedMotion } from "motion/react";
import { useFormatter } from "next-intl";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { EASE_OUT } from "@/lib/ease";

const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

function formatBinaryParts(bytes: number) {
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return { value, unit: units[unit] };
}

/** Animates a byte count in binary units with the active locale. */
export function AnimatedBytes({ bytes }: { bytes: number }) {
  const format = useFormatter();
  const used = formatBinaryParts(bytes);
  return (
    <AnimatedNumber
      value={used.value}
      duration={0.6}
      startOnView={false}
      format={(n) =>
        `${format.number(n, { maximumFractionDigits: 2 })} ${used.unit}`
      }
    />
  );
}

/** Formats a byte count in binary units with the active locale. */
export function useFormatBytes() {
  const format = useFormatter();
  return (bytes: number) => {
    const { value, unit } = formatBinaryParts(bytes);
    return `${format.number(value, { maximumFractionDigits: 2 })} ${unit}`;
  };
}

export function StorageUsage({
  label,
  usedBytes,
  quotaBytes,
}: {
  label: string;
  usedBytes: number;
  quotaBytes?: number;
}) {
  const size = useFormatBytes();
  const reduce = useReducedMotion() ?? false;
  const value =
    quotaBytes === undefined
      ? size(usedBytes)
      : `${size(usedBytes)} / ${size(quotaBytes)}`;
  const pct =
    quotaBytes && quotaBytes > 0
      ? Math.min(100, (usedBytes / quotaBytes) * 100)
      : 0;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <span className="tabular-nums">
          <span className="text-sm font-semibold text-foreground">
            <AnimatedBytes bytes={usedBytes} />
          </span>
          {quotaBytes === undefined ? null : (
            <span className="text-xs text-muted-foreground">
              {` / ${size(quotaBytes)}`}
            </span>
          )}
        </span>
      </div>
      {quotaBytes !== undefined && (
        <>
          <meter
            aria-label={label}
            aria-valuetext={value}
            min={0}
            max={quotaBytes}
            value={Math.min(usedBytes, quotaBytes)}
            className="sr-only"
          />
          <div
            aria-hidden
            className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
          >
            <motion.div
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={
                reduce ? { duration: 0 } : { duration: 0.55, ease: EASE_OUT }
              }
              className={`h-full rounded-full ${usedBytes >= quotaBytes ? "bg-destructive" : "bg-primary"}`}
            />
          </div>
        </>
      )}
    </div>
  );
}
