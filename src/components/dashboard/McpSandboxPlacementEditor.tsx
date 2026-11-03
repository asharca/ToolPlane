"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";
import {
  updateMcpSandboxPlacementAction,
  type McpSandboxPlacementActionState,
} from "@/lib/workspace/actions";
import { notify } from "./Toaster";

/** Opt-in: run this MCP inside each Agent's session sandbox. */
export function McpSandboxPlacementEditor({
  workspace,
  deploymentId,
  initialEnabled,
}: {
  workspace: string;
  deploymentId: string;
  initialEnabled: boolean;
}) {
  const t = useTranslations("console.mcp");
  const [saved, setSaved] = useState(initialEnabled);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [state, formAction, isPending] = useActionState<
    McpSandboxPlacementActionState,
    FormData
  >(async (previous, formData) => {
    const result = await updateMcpSandboxPlacementAction(previous, formData);
    if (result.savedAt) {
      setSaved(formData.get("runInAgentSandbox") === "on");
      notify(t("sandboxPlacementSaved"));
    }
    return result;
  }, {});
  const dirty = enabled !== saved;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="deploymentId" value={deploymentId} />
      {enabled ? (
        <input type="hidden" name="runInAgentSandbox" value="on" />
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium text-foreground">
          {t("runInAgentSandbox")}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("runInAgentSandbox")}
        />
      </div>
      {enabled ? (
        <div
          role="alert"
          className="flex gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-3 py-2.5 text-xs leading-5 text-foreground"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p>{t("runInAgentSandboxWarning")}</p>
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(
            state.error === "unsupported"
              ? "sandboxPlacementUnsupported"
              : "toolAccessDenied",
          )}
        </p>
      ) : null}
      {dirty ? (
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending
            ? t("savingToolExposure")
            : enabled
              ? t("confirmRunInAgentSandbox")
              : t("saveToolExposure")}
        </Button>
      ) : null}
    </form>
  );
}
