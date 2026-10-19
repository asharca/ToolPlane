"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { AdminBadge, AdminPanel } from "@/components/admin/AdminUI";
import { updateAgentConcurrencySettingsAction } from "@/lib/admin/settings-actions";
import type { AdminSettingsActionState } from "@/lib/admin/settings-actions";

export function AgentConcurrencySettingsForm({
  maxPerAgent,
  maxTotal,
  source,
  perAgentLimit,
  totalLimit,
}: {
  maxPerAgent: number;
  maxTotal: number;
  source: "database" | "default";
  perAgentLimit: number;
  totalLimit: number;
}) {
  const t = useTranslations("admin");
  const [state, action, pending] = useActionState<
    AdminSettingsActionState,
    FormData
  >(updateAgentConcurrencySettingsAction, {});

  return (
    <AdminPanel
      title={t("agentConcurrency")}
      description={t("agentConcurrencyDescription")}
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
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            {
              name: "agentMaxConcurrent",
              value: maxPerAgent,
              max: perAgentLimit,
            },
            {
              name: "agentMaxTotalConcurrent",
              value: maxTotal,
              max: totalLimit,
            },
          ].map(({ name, value, max }) => (
            <div key={name} className="space-y-1.5">
              <label htmlFor={name} className="block text-sm font-medium">
                {t(name)}
              </label>
              <Input
                id={name}
                name={name}
                type="number"
                min={1}
                max={max}
                step={1}
                required
                defaultValue={String(value)}
                aria-describedby="agent-concurrency-help"
              />
            </div>
          ))}
        </div>
        <p
          id="agent-concurrency-help"
          className="text-sm text-muted-foreground"
        >
          {t("agentConcurrencyBehavior")}
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
              {t("restoreAgentConcurrencyDefaults")}
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
