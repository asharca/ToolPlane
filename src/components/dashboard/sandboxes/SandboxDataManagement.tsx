"use client";

import { Input } from "@/components/motion/input";
import { AnimatedBadge } from "@/components/motion/animated-badge";

import { Camera, Copy, RotateCcw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  cloneSandboxAction,
  createSandboxSnapshotAction,
  deleteSandboxSnapshotAction,
  restoreSandboxSnapshotAction,
} from "@/lib/sandboxes/actions";
import { ConfirmSubmitButton } from "@/components/dashboard/ConfirmSubmitButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";

export type SandboxSnapshotItem = {
  id: string;
  name: string;
  status: string;
  error: string | null;
  createdAt: string;
};

function SnapshotStatus({ status }: { status: string }) {
  const t = useTranslations("console.sandboxes");
  const label =
    status === "ready"
      ? t("snapshotReady")
      : status === "error"
        ? t("snapshotError")
        : status === "deleting"
          ? t("snapshotDeleting")
          : t("snapshotCreating");

  return (
    <AnimatedBadge
      status={
        status === "ready"
          ? "success"
          : status === "error"
            ? "danger"
            : "loading"
      }
      size="sm"
    >
      {label}
    </AnimatedBadge>
  );
}

export function SandboxDataManagement({
  workspace,
  sandboxId,
  sandboxName,
  snapshots,
  disabled = false,
  disabledLabel,
  creationDisabled = false,
  mode = "sandbox",
  showClone = true,
}: {
  workspace: string;
  sandboxId: string;
  sandboxName: string;
  snapshots: SandboxSnapshotItem[];
  disabled?: boolean;
  disabledLabel?: string;
  creationDisabled?: boolean;
  mode?: "sandbox" | "hermes";
  showClone?: boolean;
}) {
  const t = useTranslations("console.sandboxes");
  const common = useTranslations("common");
  const isHermes = mode === "hermes";

  return (
    <section className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {isHermes ? t("hermesData") : t("workspaceData")}
          </h3>
          <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
            {isHermes
              ? t("hermesDataDescription")
              : t("workspaceDataDescription")}
          </p>
        </div>
        {disabled ? (
          <AnimatedBadge status="warning" size="sm">
            {disabledLabel ?? t("waitForProvisioning")}
          </AnimatedBadge>
        ) : creationDisabled ? (
          <AnimatedBadge status="danger" size="sm">
            {t("restoreRequired")}
          </AnimatedBadge>
        ) : null}
      </div>

      <div className="mt-4 space-y-5">
        <fieldset
          disabled={disabled || creationDisabled}
          className="disabled:opacity-60"
        >
          <div className="grid gap-4 lg:grid-cols-2">
            {showClone ? (
              <form action={cloneSandboxAction} className="space-y-2">
                <input type="hidden" name="workspace" value={workspace} />
                <input type="hidden" name="sandboxId" value={sandboxId} />
                <input
                  type="hidden"
                  name="defaultName"
                  value={t("cloneNameDefault", { name: sandboxName })}
                />
                <label
                  className="block text-xs font-medium text-muted-foreground"
                  htmlFor="sandbox-clone-name"
                >
                  {t("cloneName")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="sandbox-clone-name"
                    name="name"
                    defaultValue={t("cloneNameDefault", { name: sandboxName })}
                    maxLength={80}
                    className="min-w-0 flex-1"
                  />
                  <SubmitButton
                    flash={false}
                    pendingLabel={t("cloning")}
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                  >
                    <Copy className="size-3.5" />
                    {t("cloneSandbox")}
                  </SubmitButton>
                </div>
              </form>
            ) : null}

            <form action={createSandboxSnapshotAction} className="space-y-2">
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="sandboxId" value={sandboxId} />
              <input
                type="hidden"
                name="defaultName"
                value={t("snapshotDefaultName")}
              />
              <label
                className="block text-xs font-medium text-muted-foreground"
                htmlFor="sandbox-snapshot-name"
              >
                {t("snapshotName")}
              </label>
              <div className="flex gap-2">
                <Input
                  id="sandbox-snapshot-name"
                  name="name"
                  placeholder={t("snapshotNamePlaceholder")}
                  maxLength={80}
                  className="min-w-0 flex-1"
                />
                <SubmitButton
                  flash={false}
                  pendingLabel={t("creatingSnapshot")}
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                >
                  <Camera className="size-3.5" />
                  {t("createSnapshot")}
                </SubmitButton>
              </div>
            </form>
          </div>
        </fieldset>

        <fieldset disabled={disabled} className="disabled:opacity-60">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                {t("snapshots")}
              </h4>
              <span className="text-xs tabular-nums text-muted-foreground">
                {snapshots.length}
              </span>
            </div>
            {snapshots.length === 0 ? (
              <p className="border-t border-border py-4 text-xs text-muted-foreground">
                {t("noSnapshots")}
              </p>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {snapshots.map((snapshot) => {
                  const ready = snapshot.status === "ready";
                  return (
                    <li
                      key={snapshot.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {snapshot.name}
                          </span>
                          <SnapshotStatus status={snapshot.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {snapshot.createdAt}
                        </p>
                        {snapshot.error ? (
                          <p className="mt-1 text-xs text-destructive dark:text-destructive">
                            {t("snapshotOperationFailed")}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {ready ? (
                          <form action={restoreSandboxSnapshotAction}>
                            <input
                              type="hidden"
                              name="workspace"
                              value={workspace}
                            />
                            <input
                              type="hidden"
                              name="sandboxId"
                              value={sandboxId}
                            />
                            <input
                              type="hidden"
                              name="snapshotId"
                              value={snapshot.id}
                            />
                            <input
                              type="hidden"
                              name="recoveryName"
                              value={t("restoreRecoveryName", {
                                name: snapshot.name,
                              })}
                            />
                            <ConfirmSubmitButton
                              triggerLabel={
                                <>
                                  <RotateCcw className="size-3.5" />
                                  {t("restoreSnapshot")}
                                </>
                              }
                              confirmLabel={common("confirm")}
                              cancelLabel={common("cancel")}
                              prompt={t(
                                isHermes
                                  ? "restoreHermesSnapshotPrompt"
                                  : "restoreSnapshotPrompt",
                                { name: snapshot.name },
                              )}
                              pendingLabel={t("restoringSnapshot")}
                              promptClassName="max-w-56 text-xs text-muted-foreground"
                            />
                          </form>
                        ) : null}
                        <form action={deleteSandboxSnapshotAction}>
                          <input
                            type="hidden"
                            name="workspace"
                            value={workspace}
                          />
                          <input
                            type="hidden"
                            name="sandboxId"
                            value={sandboxId}
                          />
                          <input
                            type="hidden"
                            name="snapshotId"
                            value={snapshot.id}
                          />
                          <ConfirmSubmitButton
                            triggerLabel={
                              <>
                                <Trash2 className="size-3.5" />
                                {t("deleteSnapshot")}
                              </>
                            }
                            confirmLabel={common("confirm")}
                            cancelLabel={common("cancel")}
                            prompt={t("deleteSnapshotPrompt", {
                              name: snapshot.name,
                            })}
                            pendingLabel={t("deletingSnapshot")}
                            promptClassName="max-w-56 text-xs text-muted-foreground"
                          />
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
