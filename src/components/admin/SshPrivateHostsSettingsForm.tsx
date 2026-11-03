"use client";

import { useActionState } from "react";
import { Network, RotateCcw, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import {
  updateSshPrivateHostsSettingsAction,
  type AdminSettingsActionState,
} from "@/lib/admin/settings-actions";

const MAX_PRIVATE_HOSTS_LENGTH = 8_192;

export function SshPrivateHostsSettingsForm({
  value,
  source,
}: {
  value: string;
  source: "database" | "default";
}) {
  const t = useTranslations("admin");
  const [state, action, isPending] = useActionState<
    AdminSettingsActionState,
    FormData
  >(updateSshPrivateHostsSettingsAction, {});

  return (
    <AdminPanel
      title={t("sshPrivateHosts")}
      description={t("sshPrivateHostsDescription")}
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
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/25 p-4">
          <Network
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-sm leading-6 text-muted-foreground">
            {t("sshPrivateHostsBehavior")}
          </p>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="ssh-private-hosts"
            className="block text-sm font-medium text-foreground"
          >
            {t("sshPrivateHostsLabel")}
          </label>
          <textarea
            id="ssh-private-hosts"
            name="sshPrivateHosts"
            defaultValue={value}
            rows={4}
            maxLength={MAX_PRIVATE_HOSTS_LENGTH}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-describedby="ssh-private-hosts-hint"
            className="min-h-36 w-full resize-y rounded-lg bg-muted/35 p-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p
            id="ssh-private-hosts-hint"
            className="text-xs text-muted-foreground"
          >
            {t("sshPrivateHostsHint")}
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
              {t("sshPrivateHostsReset")}
            </Button>
          ) : null}
        </div>
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p className="text-sm text-accent-foreground" aria-live="polite">
            {t("sshPrivateHostsSaved")}
          </p>
        ) : null}
      </form>
    </AdminPanel>
  );
}
