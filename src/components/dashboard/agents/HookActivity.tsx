"use client";

import { z } from "zod";
import { useTranslations } from "next-intl";
import { ToolResult } from "@/components/agents/tool-result";
import { SubagentSourceLabel, SubagentSourceSchema } from "./SubagentActivity";

export const HookActivitySchema = z.object({
  id: z.string(),
  pluginInstallId: z.string(),
  pluginName: z.string(),
  event: z.string(),
  status: z.enum(["completed", "failed", "timed_out"]),
  durationMs: z.number().nonnegative(),
  source: SubagentSourceSchema.optional(),
  result: z.enum(["blocked", "cancelled", "modified", "unchanged"]).optional(),
});

/** Sanitized records of real handler invocations, never hook inputs or error payloads. */
export function HookActivity({ value }: { value: unknown }) {
  const t = useTranslations("console.work.nativeUi.hooks");
  const parsed = HookActivitySchema.safeParse(value);
  if (!parsed.success) return null;
  const hook = parsed.data;
  return (
    <div className="min-w-0 space-y-2">
      {hook.source ? <SubagentSourceLabel source={hook.source} /> : null}
      <ToolResult
        tool={hook.pluginName}
        title={`${hook.event} · ${t(`status.${hook.status}`)}`}
        status={hook.status === "completed" ? "success" : "error"}
        kind="custom"
        meta={t("duration", { ms: Math.round(hook.durationMs) })}
      >
        <dl className="grid gap-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-muted-foreground">{t("plugin")}</dt>
          <dd className="break-all font-mono">{hook.pluginInstallId}</dd>
          <dt className="text-muted-foreground">{t("event")}</dt>
          <dd className="break-all font-mono">{hook.event}</dd>
          <dt className="text-muted-foreground">{t("invocation")}</dt>
          <dd className="break-all font-mono">{hook.id}</dd>
          {hook.result ? (
            <>
              <dt className="text-muted-foreground">{t("result")}</dt>
              <dd>{t(`outcomes.${hook.result}`)}</dd>
            </>
          ) : null}
        </dl>
      </ToolResult>
    </div>
  );
}
