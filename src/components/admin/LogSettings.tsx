"use client";
import { FormSelect } from "@/components/ui/FormSelect";

import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import {
  ChevronDown,
  CircleStop,
  Clock3,
  Play,
  Save,
  Settings,
} from "lucide-react";
import { updateLogSettings } from "@/lib/admin/log-actions";
import type { LogSettings as SettingsValue } from "@/lib/observability/settings";

export function LogSettings({ settings }: { settings: SettingsValue }) {
  const t = useTranslations("admin");
  const fieldId = useId();
  const [state, action, pending] = useActionState(updateLogSettings, {});
  return (
    <details id="log-settings" className="group border-t border-border pt-4">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <Settings className="size-4 text-muted-foreground" aria-hidden="true" />
        {t("logsSettings")}
        {settings.captures.length ? (
          <AnimatedBadge status="warning">
            {t("logsActiveCaptures", { count: settings.captures.length })}
          </AnimatedBadge>
        ) : null}
        <ChevronDown
          className="ml-auto size-4 text-muted-foreground group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <fieldset disabled={pending} className="min-w-0 disabled:opacity-60">
        <p className="pt-4 text-xs text-muted-foreground">
          {t("logsDefaultPayloadPolicy")}
        </p>
        <div className="grid gap-6 py-5 xl:grid-cols-2">
          <form action={action} className="min-w-0 space-y-4">
            <h3 className="text-sm font-medium">{t("logsRetention")}</h3>
            <input type="hidden" name="intent" value="retention" />
            <div className="grid gap-3 sm:grid-cols-3">
              {(["eventDays", "detailDays", "auditDays"] as const).map(
                (key) => (
                  <label
                    key={key}
                    htmlFor={`${fieldId}-${key}`}
                    className="grid min-w-0 gap-1.5 text-xs font-medium"
                  >
                    {t(`logs_${key}`)}
                    <Input
                      id={`${fieldId}-${key}`}
                      className="w-full"
                      type="number"
                      required
                      name={key}
                      min={key === "auditDays" ? 30 : 1}
                      max={
                        key === "detailDays"
                          ? 30
                          : key === "eventDays"
                            ? 365
                            : 3650
                      }
                      defaultValue={String(settings[key])}
                    />
                  </label>
                ),
              )}
            </div>
            <Button type="submit" variant="secondary">
              <Save className="size-4" aria-hidden="true" />
              {pending ? t("saving") : t("logsSave")}
            </Button>
          </form>
          <form
            action={action}
            className="min-w-0 space-y-4 border-t border-border pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0"
          >
            <h3 className="text-sm font-medium">
              {t("logsDiagnosticCapture")}
            </h3>
            <input type="hidden" name="intent" value="capture" />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className="grid min-w-0 gap-1.5 text-xs font-medium">
                {t("logsCapture")}
                <FormSelect
                  name="field"
                  className="w-full"
                  label={t("logsCapture")}
                  options={[
                    ...["workspaceId", "deploymentId", "agentId"].map(
                      (key) => ({ value: key, label: t(`logFields.${key}`) }),
                    ),
                  ]}
                />
              </div>
              <label
                htmlFor={`${fieldId}-resource`}
                className="grid min-w-0 gap-1.5 text-xs font-medium"
              >
                {t("logsResource")}
                <Input
                  id={`${fieldId}-resource`}
                  name="id"
                  required
                  maxLength={200}
                  placeholder="ID"
                  className="w-full"
                />
              </label>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <FormCheckbox
                name="includeAgentContent"
                value="confirmed"
                label={t("logsAgentContentConsent")}
                disabled={pending}
              />
            </div>
            <Button type="submit" variant="secondary">
              <Play className="size-4" aria-hidden="true" />
              {t("logsStartCapture")}
            </Button>
          </form>
        </div>
        {settings.captures.length ? (
          <div className="space-y-3 border-t border-border py-4">
            <ul className="divide-y divide-border">
              {settings.captures.map((item) => (
                <li
                  key={`${item.field}:${item.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-xs"
                >
                  <AnimatedBadge status="warning">
                    {item.includeAgentContent
                      ? t("logsAgentContentCapture")
                      : t("logsCapturing")}
                  </AnimatedBadge>
                  <span className="min-w-0 flex-1 break-all font-mono">
                    {t(`logFields.${item.field}`)}: {item.id}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    <Clock3 className="size-3.5" aria-hidden="true" />
                    {t("logsExpires")}: {item.expiresAt}
                  </span>
                </li>
              ))}
            </ul>
            <form action={action}>
              <input type="hidden" name="intent" value="stop" />
              <Button type="submit" variant="secondary">
                <CircleStop className="size-4" aria-hidden="true" />
                {t("logsStopCapture")}
              </Button>
            </form>
          </div>
        ) : null}
      </fieldset>
      {state.error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {state.error}
        </p>
      ) : state.ok ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t("saved")}
        </p>
      ) : null}
    </details>
  );
}
