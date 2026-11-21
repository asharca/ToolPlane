"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertTriangle, Sparkles } from "lucide-react";
import { Switch } from "@/components/motion/switch";
import { setMcpSamplingAction } from "@/lib/workspace/mcp-config-actions";
import type { McpConfigFailure } from "@/lib/workspace/mcp-config-types";
import { notify } from "./Toaster";

type TranslateFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;

function formatSamplingError(
  failure: McpConfigFailure,
  t: TranslateFn,
): string {
  if (failure.issue) {
    return t(`intake.issues.${failure.issue.code}`, {
      value: failure.issue.value ?? "",
    });
  }
  return t(`config.errors.${failure.error}`);
}

export function McpSamplingToggle({
  workspace,
  deploymentId,
  initialEnabled,
  canManage,
}: {
  workspace: string;
  deploymentId: string;
  initialEnabled: boolean;
  canManage: boolean;
}) {
  const t = useTranslations("console.mcp");
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle(next: boolean) {
    if (!canManage || isPending) return;
    const previous = enabled;
    setEnabled(next);
    setError(null);
    startTransition(async () => {
      try {
        const result = await setMcpSamplingAction({
          workspace,
          deploymentId,
          enabled: next,
        });
        if (!result.ok) {
          setEnabled(previous);
          setError(formatSamplingError(result, t));
          return;
        }
        notify(t("config.samplingSaved"));
        router.refresh();
      } catch {
        setEnabled(previous);
        setError(t("config.errors.saveFailed"));
      }
    });
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            {t("config.samplingTitle")}
          </h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("config.samplingDescription")}
        </p>
      </header>
      <div className="space-y-4 px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-foreground">
            {t("config.samplingToggleLabel")}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={!canManage || isPending}
            ariaLabel={t("config.samplingToggleLabel")}
          />
        </div>

        <div
          role="note"
          className="flex gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-3 py-2.5 text-xs leading-5 text-foreground"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p>{t("config.samplingQuotaWarning")}</p>
        </div>

        {!canManage ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t("config.samplingManageOnly")}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
