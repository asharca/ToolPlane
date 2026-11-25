"use client";
import { Button } from "@/components/motion/button";

import { useActionState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  updatePrivateHostsSettingsAction,
  type AdminSettingsActionState,
} from "@/lib/admin/settings-actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { notify } from "@/components/dashboard/Toaster";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";

const MAX_PRIVATE_HOSTS_LENGTH = 8_192;

export function PrivateHostsSettingsForm({
  value,
  source,
}: {
  value: string;
  source: "database" | "environment" | "default";
}) {
  const t = useTranslations("admin");
  const [state, action, isPending] = useActionState<
    AdminSettingsActionState,
    FormData
  >(async (prev, form) => {
    const result = await updatePrivateHostsSettingsAction(prev, form);
    if (result.error) notify(result.error, { severity: "error" });
    else if (result.ok) notify(t("privateHostsSaved"));
    return result;
  }, {});
  const sourceLabel =
    source === "database"
      ? t("settingsSourceAdmin")
      : source === "environment"
        ? t("settingsSourceEnvironment")
        : t("settingsSourceDefault");

  return (
    <AdminPanel
      title={t("privateHosts")}
      description={t("privateHostsDescription")}
      actions={
        <AdminBadge tone={source === "database" ? "info" : "neutral"}>
          {sourceLabel}
        </AdminBadge>
      }
    >
      <form action={action} className="space-y-5">
        <div className="space-y-1.5">
          <label
            htmlFor="private-hosts"
            className="block text-sm font-medium text-foreground"
          >
            {t("privateHostsLabel")}
          </label>
          <textarea
            id="private-hosts"
            name="privateHosts"
            defaultValue={value}
            rows={4}
            maxLength={MAX_PRIVATE_HOSTS_LENGTH}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-describedby="private-hosts-hint"
            className="min-h-36 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p id="private-hosts-hint" className="text-xs text-muted-foreground">
            {t("privateHostsHint")}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <SubmitButton
            pendingLabel={t("saving")}
            savedLabel={t("saved")}
            error={state.error}
            variant="primary"
            size="md"
          >
            <Save className="size-4" />
            {t("saveChanges")}
          </SubmitButton>
          {source === "database" ? (
            <Button
              type="submit"
              name="intent"
              value="reset"
              formNoValidate
              disabled={isPending}
              variant="secondary"
              size="md"
            >
              <RotateCcw className="size-4" />
              {t("restoreEnvironmentDefault")}
            </Button>
          ) : null}
        </div>

        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
      </form>
    </AdminPanel>
  );
}
