"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { History, Loader2, RotateCcw } from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { rollbackMcpConfigAction } from "@/lib/workspace/mcp-config-actions";
import type {
  McpConfigFailure,
  McpConfigRevisionSummary,
} from "@/lib/workspace/mcp-config-types";
import { notify } from "./Toaster";

type TranslateFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;

function formatRevisionError(
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

function formatRevisionTime(iso: string, locale: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function McpConfigRevisions({
  workspace,
  deploymentId,
  revisions,
  canManage,
}: {
  workspace: string;
  deploymentId: string;
  revisions: McpConfigRevisionSummary[];
  canManage: boolean;
}) {
  const t = useTranslations("console.mcp");
  const locale = useLocale();
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRollback(revisionId: string) {
    if (!canManage || isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await rollbackMcpConfigAction({
          workspace,
          deploymentId,
          revisionId,
        });
        if (!result.ok) {
          setError(formatRevisionError(result, t));
          return;
        }
        setConfirmingId(null);
        notify(t("config.rolledBack", { revision: result.revision }));
        router.refresh();
      } catch {
        setError(t("config.errors.saveFailed"));
      }
    });
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            {t("config.revisionsTitle")}
          </h2>
          <AnimatedBadge status="neutral" size="sm" showIcon={false}>
            {revisions.length}
          </AnimatedBadge>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("config.revisionsDescription")}
        </p>
      </header>

      {error ? (
        <div className="border-b border-border px-5 py-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        </div>
      ) : null}

      {revisions.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          {t("config.noRevisions")}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {revisions.map((item) => {
            const isConfirming = confirmingId === item.id;
            return (
              <li key={item.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-foreground">
                        {t("config.revisionNumber", {
                          revision: item.revision,
                        })}
                      </span>
                      <AnimatedBadge
                        status="neutral"
                        size="sm"
                        showIcon={false}
                      >
                        {t(`config.format.${item.format}`)}
                      </AnimatedBadge>
                      {item.active ? (
                        <AnimatedBadge status="success" size="sm">
                          {t("config.activeRevision")}
                        </AnimatedBadge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <span>{formatRevisionTime(item.createdAt, locale)}</span>
                      <span className="mx-1.5">·</span>
                      <span>
                        {item.createdByName ?? t("config.authorSystem")}
                      </span>
                    </p>
                  </div>

                  {!item.active && canManage ? (
                    isConfirming ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-foreground">
                          {t("config.rollbackConfirmPrompt", {
                            revision: item.revision,
                          })}
                        </span>
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          disabled={isPending}
                          onClick={() => handleRollback(item.id)}
                        >
                          {isPending ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3.5" />
                          )}
                          {isPending
                            ? t("config.rollingBack")
                            : t("config.confirmRollbackButton")}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={isPending}
                          onClick={() => setConfirmingId(null)}
                        >
                          {t("cancel")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={isPending}
                        onClick={() => {
                          setError(null);
                          setConfirmingId(item.id);
                        }}
                      >
                        <RotateCcw className="size-3.5" />
                        {t("config.rollbackButton")}
                      </Button>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
