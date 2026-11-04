"use client";

import { useActionState, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import {
  updateAgentSandboxAutoStopSettingsAction,
  type AdminSettingsActionState,
} from "@/lib/admin/settings-actions";

export function AgentSandboxAutoStopSettingsForm({
  enabled: initialEnabled,
  source,
}: {
  enabled: boolean;
  source: "database" | "default";
}) {
  const t = useTranslations("admin");
  const [enabled, setEnabled] = useState(initialEnabled);
  const checkbox = useRef<HTMLInputElement>(null);
  const [state, action, pending] = useActionState<
    AdminSettingsActionState,
    FormData
  >(updateAgentSandboxAutoStopSettingsAction, {});

  return (
    <AdminPanel
      title={t("agentSandboxAutoStop")}
      description={t("agentSandboxAutoStopDescription")}
      actions={
        <AdminBadge tone={source === "database" ? "info" : "neutral"}>
          {t(
            source === "database"
              ? "settingsSourceAdmin"
              : "settingsSourceDefault",
          )}
        </AdminBadge>
      }
    >
      <form action={action} className="space-y-5">
        <input
          type="hidden"
          name="agentSandboxAutoStopEnabled"
          value={String(enabled)}
        />
        {/* Native change events keep SettingsChanges aware of this switch. */}
        <input
          ref={checkbox}
          type="checkbox"
          hidden
          checked={enabled}
          disabled={pending}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <Switch
          checked={enabled}
          onCheckedChange={() => checkbox.current?.click()}
          disabled={pending}
          label={t("agentSandboxAutoStop")}
        />
        <p className="text-sm text-muted-foreground">
          {t("agentSandboxAutoStopBehavior")}
        </p>
        <div className="flex flex-wrap gap-2">
          <SubmitButton
            pendingLabel={t("saving")}
            savedLabel={t("saved")}
            error={state.error}
            variant="primary"
            size="md"
          >
            {t("saveChanges")}
          </SubmitButton>
          {source === "database" ? (
            <Button
              type="submit"
              name="intent"
              value="reset"
              formNoValidate
              disabled={pending}
              variant="secondary"
              size="md"
            >
              {t("restoreAgentSandboxAutoStopDefault")}
            </Button>
          ) : null}
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p aria-live="polite" className="text-sm text-accent-foreground">
            {t("saved")}
          </p>
        ) : null}
      </form>
    </AdminPanel>
  );
}
