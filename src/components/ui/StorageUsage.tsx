import { useFormatter } from "next-intl";

const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function StorageUsage({
  label,
  usedBytes,
  quotaBytes,
}: {
  label: string;
  usedBytes: number;
  quotaBytes?: number;
}) {
  const format = useFormatter();
  function size(bytes: number) {
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
      bytes /= 1024;
      unit++;
    }
    return `${format.number(bytes, { maximumFractionDigits: 2 })} ${units[unit]}`;
  }
  const value =
    quotaBytes === undefined
      ? size(usedBytes)
      : `${size(usedBytes)} / ${size(quotaBytes)}`;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
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
            className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className={`h-full rounded-full ${usedBytes >= quotaBytes ? "bg-destructive" : "bg-primary"}`}
              style={{
                width: `${Math.min(100, (usedBytes / quotaBytes) * 100)}%`,
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
