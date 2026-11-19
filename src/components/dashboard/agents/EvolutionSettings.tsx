"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/motion/button";
import { FormCheckbox } from "@/components/ui/FormCheckbox";
import type { EvolutionOverviewDto } from "@/lib/agents/evolution/contracts";
import {
  Field,
  inputClass,
  type EvolutionFormat,
  type Mutation,
} from "./evolution-ui";

export function EvolutionSettings({
  overview,
  busy,
  mutate,
  format,
}: {
  overview: EvolutionOverviewDto;
  busy: boolean;
  mutate: Mutation;
  format: EvolutionFormat;
}) {
  const t = useTranslations("console.evolution");
  const { settings } = overview;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [automatic, setAutomatic] = useState(settings.reflectionEnabled);
  const [interval, setInterval] = useState(
    String(settings.reflectionIntervalHours),
  );
  const [budgetUsd, setBudgetUsd] = useState(
    String(Number(settings.monthlyBudgetMicros) / 1_000_000),
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate("settings", "PUT", {
          enabled,
          reflectionEnabled: automatic,
          reflectionIntervalHours: Number(interval),
          monthlyBudgetMicros: String(
            Math.round(Number(budgetUsd) * 1_000_000),
          ),
        });
      }}
    >
      <fieldset
        className="min-w-0 space-y-4"
        disabled={busy || !overview.permissions.canReview}
      >
        <div className="space-y-1">
          <FormCheckbox
            checked={enabled}
            onCheckedChange={setEnabled}
            label={t("enabled")}
          />
          <p className="text-xs text-muted-foreground">{t("enabledHelp")}</p>
        </div>
        <FormCheckbox
          checked={automatic}
          onCheckedChange={setAutomatic}
          label={t("automatic")}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("interval")}>
            <input
              className={inputClass}
              type="number"
              required
              min={1}
              max={8760}
              disabled={!automatic}
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
            />
          </Field>
          <Field label={t("budget")} help={t("budgetHelp")}>
            <input
              className={inputClass}
              type="number"
              required
              min={0}
              max={1_000_000}
              step={0.01}
              value={budgetUsd}
              onChange={(event) => setBudgetUsd(event.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {t("save")}
        </Button>
      </fieldset>
      <p className="text-sm">
        {t("spent", {
          spent: format.money(settings.spentMicros),
          budget: format.money(settings.monthlyBudgetMicros),
        })}
      </p>
      {settings.enabled && settings.nextReflectionAt ? (
        <p className="text-sm text-muted-foreground">
          {t("nextReflection", {
            time: format.date(settings.nextReflectionAt),
          })}
        </p>
      ) : null}
    </form>
  );
}
