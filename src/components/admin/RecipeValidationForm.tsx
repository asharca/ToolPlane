"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";
import {
  validateServerRecipeAction,
  type RecipeActionState,
} from "@/lib/admin/market-actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";

export function RecipeValidationForm({
  serverId,
  verifiedAt,
  verifiedTools,
}: {
  serverId: string;
  verifiedAt: string | null;
  verifiedTools: number | null;
}) {
  const t = useTranslations("admin");
  const [state, action] = useActionState<RecipeActionState, FormData>(
    validateServerRecipeAction,
    {},
  );
  return (
    <AdminPanel
      title={t("deployRecipe")}
      description={t("githubManagedResources")}
      actions={
        <AdminBadge tone={verifiedAt ? "success" : "neutral"} dot>
          {verifiedAt
            ? `${t("verified")} · ${verifiedTools ?? 0} ${t("tools")}`
            : t("unverified")}
        </AdminBadge>
      }
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="id" value={serverId} />
        <label className="block space-y-1.5 text-sm font-medium">
          <span>
            {t("testEnvForValidationOptionalKeyvaluePerLineNotStored")}
          </span>
          <textarea
            name="testEnv"
            rows={4}
            autoCapitalize="none"
            spellCheck={false}
            className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <SubmitButton
          error={state.error}
          flash={false}
          pendingLabel={t("validatingFirstRun1Min")}
          variant="secondary"
          size="md"
        >
          <ShieldCheck className="size-4" />
          {t("validate")}
        </SubmitButton>
        {state.ok ? (
          <p role="status" className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              {t("passed")} {state.toolCount} {t("tools")}
              {state.tools?.length ? `: ${state.tools.join(", ")}` : ""}
            </span>
          </p>
        ) : null}
        {state.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}
      </form>
    </AdminPanel>
  );
}
