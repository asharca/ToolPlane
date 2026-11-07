"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/motion/button/base";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { approveAgentPluginSyncAction } from "@/lib/agents/actions";

export type AgentPluginCapabilityDiff = {
  addedMcp: { key: string; tools: string[]; requirementAdded: boolean }[];
  codeChanged: boolean;
};

/** Sync badge with an inline review; it lives inside the settings dialog, so it never opens another. */
export function AgentPluginSyncReview({
  slug,
  agentId,
  installId,
  syncStatus,
  syncError,
  enabledVersion,
  targetVersion,
  targetReleaseId,
  capabilityDiff,
  canApprove,
  disabled,
}: {
  slug: string;
  agentId: string;
  installId: string;
  syncStatus: string;
  syncError: string | null;
  enabledVersion: string | null;
  targetVersion: string | null;
  targetReleaseId: string | null;
  capabilityDiff: AgentPluginCapabilityDiff | null;
  canApprove: boolean;
  disabled: boolean;
}) {
  const t = useTranslations("console.agents.pluginSync");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const status =
    syncStatus === "pending"
      ? "pending"
      : syncStatus === "review_required"
        ? "review_required"
        : syncStatus === "failed"
          ? "failed"
          : "synced";

  async function approve() {
    if (!targetReleaseId) return;
    setPending(true);
    setError("");
    try {
      const data = new FormData();
      data.set("workspace", slug);
      data.set("agentId", agentId);
      data.set("installId", installId);
      data.set("targetReleaseId", targetReleaseId);
      const result = await approveAgentPluginSyncAction(data);
      router.refresh();
      if (result.syncStatus === "failed")
        setError(result.syncError ?? t("failed"));
      else setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AnimatedBadge
          size="sm"
          status={
            status === "synced"
              ? "success"
              : status === "pending"
                ? "loading"
                : status === "failed"
                  ? "danger"
                  : "warning"
          }
        >
          {t(status)}
        </AnimatedBadge>
        {status === "review_required" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {t("review")} ·{" "}
            {t("versions", {
              from: enabledVersion ?? "—",
              to: targetVersion ?? "—",
            })}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          {capabilityDiff ? (
            <>
              <section className="space-y-2">
                <h4 className="text-xs font-medium">{t("addedMcp")}</h4>
                {capabilityDiff.addedMcp.length ? (
                  <ul className="space-y-2">
                    {capabilityDiff.addedMcp.map(
                      ({ key, tools, requirementAdded }) => (
                        <li
                          key={key}
                          className="rounded-md border border-border bg-background p-2"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="text-xs">{key}</code>
                            {requirementAdded ? (
                              <span className="text-xs text-muted-foreground">
                                {t("newRequirement")}
                              </span>
                            ) : null}
                          </div>
                          {tools.length ? (
                            <ul className="mt-1 list-inside list-disc font-mono text-xs">
                              {tools.map((tool) => (
                                <li key={tool}>{tool}</li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ),
                    )}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("none")}</p>
                )}
              </section>
              <p className="text-xs">
                {t("codeChanged", {
                  changed: capabilityDiff.codeChanged ? t("yes") : t("no"),
                })}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
          )}
          {error ? (
            <p role="alert" className="break-words text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {canApprove ? (
            <Button
              type="button"
              size="sm"
              disabled={pending || disabled}
              onClick={approve}
            >
              {pending ? t("approving") : t("approve")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {status === "failed" && syncError ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {syncError}
        </p>
      ) : null}
    </div>
  );
}
