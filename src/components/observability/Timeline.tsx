"use client";

import { useTranslations } from "next-intl";
import type { TimelineEntry } from "@/lib/observability/views/types";
import { RelativeTime, StatusBadge } from "./LogPrimitives";

const eventLabels: Record<string, string> = {
  "gateway.request": "gatewayRequest",
  "mcp.rpc": "mcpRpc",
  "mcp.internal": "mcpInternal",
  "sandbox.tool": "sandboxTool",
  "a2a.request": "a2aRequest",
  "a2a.task.started": "a2aTaskStarted",
  "a2a.task.settled": "a2aTaskSettled",
};
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const t = useTranslations("console.observability.viewer");
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{t("timeline")}</h2>
      <ol className="space-y-3 border-l border-border pl-4">
        {entries.map((entry) => (
          <li key={entry.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <RelativeTime value={entry.time} />
              {entry.state && <StatusBadge status={entry.state} />}
              <span className="text-xs text-muted-foreground">
                {entry.eventName && eventLabels[entry.eventName]
                  ? t(`events.${eventLabels[entry.eventName]}`)
                  : (entry.eventName ?? entry.level)}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">
              {entry.message}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
