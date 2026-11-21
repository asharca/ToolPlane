"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Box, Container, Loader2, Save } from "lucide-react";
import { Button } from "@/components/motion/button";
import { RadioGroup, RadioGroupItem } from "@/components/motion/radio";
import { FormSelect } from "@/components/ui/FormSelect";
import { setMcpRuntimeTargetAction } from "@/lib/workspace/mcp-config-actions";
import type {
  McpConfigFailure,
  McpRuntimeSandboxOption,
  McpRuntimeTarget,
} from "@/lib/workspace/mcp-config-types";
import { notify } from "./Toaster";

type TranslateFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;

function formatRuntimeTargetError(
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

export function McpRuntimeTargetControl({
  workspace,
  deploymentId,
  kind,
  initialTarget,
  initialSandboxId,
  sandboxes,
  canManage,
}: {
  workspace: string;
  deploymentId: string;
  kind: "remote" | "stdio";
  initialTarget: McpRuntimeTarget;
  initialSandboxId: string | null;
  sandboxes: McpRuntimeSandboxOption[];
  canManage: boolean;
}) {
  const t = useTranslations("console.mcp");
  const router = useRouter();
  const [savedTarget, setSavedTarget] =
    useState<McpRuntimeTarget>(initialTarget);
  const [savedSandboxId, setSavedSandboxId] = useState<string | null>(
    initialSandboxId,
  );
  const [target, setTarget] = useState<McpRuntimeTarget>(initialTarget);
  const [sandboxId, setSandboxId] = useState<string>(
    initialSandboxId ?? sandboxes[0]?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isStdio = kind === "stdio";
  const controlsDisabled = !canManage || !isStdio || isPending;
  const effectiveSandboxId =
    target === "workspace_sandbox" ? sandboxId || null : null;
  const dirty =
    target !== savedTarget ||
    (target === "workspace_sandbox" && effectiveSandboxId !== savedSandboxId);
  const canSubmit =
    canManage &&
    isStdio &&
    dirty &&
    !isPending &&
    (target === "managed" || Boolean(effectiveSandboxId));

  function handleSave() {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setMcpRuntimeTargetAction({
          workspace,
          deploymentId,
          target,
          sandboxId:
            target === "workspace_sandbox"
              ? (effectiveSandboxId ?? undefined)
              : undefined,
        });
        if (!result.ok) {
          setError(formatRuntimeTargetError(result, t));
          return;
        }
        setSavedTarget(target);
        setSavedSandboxId(effectiveSandboxId);
        notify(t("config.runtimeTargetSaved"));
        router.refresh();
      } catch {
        setError(t("config.errors.saveFailed"));
      }
    });
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">
          {t("config.runtimeTargetTitle")}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("config.runtimeTargetDescription")}
        </p>
      </header>
      <div className="space-y-4 px-5 py-4">
        {!isStdio ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t("config.runtimeTargetStdioOnly")}
          </p>
        ) : (
          <>
            <RadioGroup
              value={target}
              onValueChange={(next) => {
                setTarget(next as McpRuntimeTarget);
                setError(null);
              }}
              orientation="horizontal"
            >
              <div className="min-w-0 flex-1 space-y-1.5 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Container className="size-4 shrink-0 text-muted-foreground" />
                  <RadioGroupItem
                    value="managed"
                    label={t("config.targetManaged")}
                    disabled={controlsDisabled}
                  />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("config.targetManagedDescription")}
                </p>
              </div>
              <div className="min-w-0 flex-1 space-y-1.5 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Box className="size-4 shrink-0 text-muted-foreground" />
                  <RadioGroupItem
                    value="workspace_sandbox"
                    label={t("config.targetWorkspaceSandbox")}
                    disabled={controlsDisabled}
                  />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("config.targetWorkspaceSandboxDescription")}
                </p>
              </div>
            </RadioGroup>

            {target === "workspace_sandbox" ? (
              <div className="max-w-md space-y-1.5">
                <label
                  htmlFor="mcp-runtime-sandbox-select"
                  className="block text-xs font-medium text-muted-foreground"
                >
                  {t("config.sandboxSelectLabel")}
                </label>
                {sandboxes.length > 0 ? (
                  <FormSelect
                    id="mcp-runtime-sandbox-select"
                    name="runtimeSandboxId"
                    label={t("config.sandboxSelectLabel")}
                    value={sandboxId}
                    onValueChange={(next) => {
                      setSandboxId(next);
                      setError(null);
                    }}
                    disabled={controlsDisabled}
                    options={sandboxes.map((sandbox) => ({
                      value: sandbox.id,
                      label: `${sandbox.name} (${sandbox.kind})`,
                    }))}
                  />
                ) : (
                  <p
                    role="status"
                    className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-foreground"
                  >
                    {t("config.noSandboxesAvailable")}
                  </p>
                )}
              </div>
            ) : null}
          </>
        )}

        {!canManage ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t("config.runtimeTargetManageOnly")}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {isStdio ? (
          <div className="flex items-center justify-end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canSubmit}
              onClick={handleSave}
            >
              {isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {isPending
                ? t("config.savingRuntimeTarget")
                : t("config.saveRuntimeTarget")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
