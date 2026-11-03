"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/motion/button/base";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import {
  CenterMorphModal,
  CenterMorphModalTrigger,
  CenterMorphModalContent,
} from "@/components/motion/center-morph-modal";
import { approveAgentPluginSyncAction } from "@/lib/agents/actions";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogHeader,
} from "@/components/dashboard/dialog";

export type AgentPluginCapabilityDiff = {
  addedMcp: { key: string; tools: string[]; requirementAdded: boolean }[];
  codeChanged: boolean;
};

export function AgentPluginSyncReview({
  slug,
  agentId,
  installId,
  name,
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
  name: string;
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
  const common = useTranslations("console.agents");
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
          <CenterMorphModal open={open} onOpenChange={setOpen}>
            <CenterMorphModalTrigger>
              <Button type="button" variant="secondary" size="sm">
                {t("review")}
              </Button>
            </CenterMorphModalTrigger>
            <CenterMorphModalContent
              ariaLabel={t("reviewTitle", { name })}
              closeButtonLabel={common("close")}
              className="flex max-h-[calc(100dvh-4rem)] max-w-xl flex-col"
            >
              <DialogHeader
                title={t("reviewTitle", { name })}
                description={t("versions", {
                  from: enabledVersion ?? "—",
                  to: targetVersion ?? "—",
                })}
              />
              <DialogBody>
                {capabilityDiff ? (
                  <>
                    <section className="space-y-2">
                      <h3 className="text-sm font-medium">{t("addedMcp")}</h3>
                      {capabilityDiff.addedMcp.length ? (
                        <ul className="space-y-2 text-sm">
                          {capabilityDiff.addedMcp.map(
                            ({ key, tools, requirementAdded }) => (
                              <li
                                key={key}
                                className="rounded-lg border border-border p-3"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <code>{key}</code>
                                  {requirementAdded ? (
                                    <span className="text-xs text-muted-foreground">
                                      {t("newRequirement")}
                                    </span>
                                  ) : null}
                                </div>
                                {tools.length ? (
                                  <ul className="mt-2 list-inside list-disc font-mono text-xs">
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
                        <p className="text-sm text-muted-foreground">
                          {t("none")}
                        </p>
                      )}
                    </section>
                    <p className="text-sm">
                      {t("codeChanged", {
                        changed: capabilityDiff.codeChanged
                          ? t("yes")
                          : t("no"),
                      })}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("unavailable")}
                  </p>
                )}
                {error ? (
                  <p
                    role="alert"
                    className="break-words text-sm text-destructive"
                  >
                    {error}
                  </p>
                ) : null}
              </DialogBody>
              <DialogFooter cancel={<DialogCancel disabled={pending} />}>
                {canApprove ? (
                  <Button
                    type="button"
                    size="md"
                    disabled={pending || disabled}
                    onClick={approve}
                  >
                    {pending ? t("approving") : t("approve")}
                  </Button>
                ) : null}
              </DialogFooter>
            </CenterMorphModalContent>
          </CenterMorphModal>
        ) : null}
      </div>
      {status === "failed" && syncError ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {syncError}
        </p>
      ) : null}
    </div>
  );
}
