"use client";
import { Input } from "@/components/motion/input";

import { useActionState } from "react";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { notify } from "@/components/dashboard/Toaster";
import { AdminPanel } from "@/components/admin/AdminUI";
import {
  updateSkillImportLimitAction,
  type AdminSettingsActionState,
} from "@/lib/admin/settings-actions";
import {
  MAX_SKILL_IMPORT_SKILLS,
  MIN_SKILL_IMPORT_SKILLS,
} from "@/lib/skills/limits";

export function SkillImportSettingsForm({ maxSkills }: { maxSkills: number }) {
  const t = useTranslations("admin");
  const [state, action] = useActionState<AdminSettingsActionState, FormData>(
    async (prev, form) => {
      const result = await updateSkillImportLimitAction(prev, form);
      if (result.error) notify(result.error, { severity: "error" });
      else if (result.ok) notify(t("saved"));
      return result;
    },
    {},
  );

  return (
    <AdminPanel
      title={t("skillImports")}
      description={t("skillImportsDescription")}
    >
      <form action={action} className="max-w-2xl space-y-5">
        <div className="max-w-sm space-y-1.5 text-sm font-medium text-foreground">
          <label htmlFor="skill-import-max-skills">
            {t("skillImportMaxSkills")}
          </label>
          <Input
            id="skill-import-max-skills"
            name="skillImportMaxSkills"
            type="number"
            min={MIN_SKILL_IMPORT_SKILLS}
            max={MAX_SKILL_IMPORT_SKILLS}
            step="1"
            inputMode="numeric"
            required
            defaultValue={String(maxSkills)}
            aria-describedby="skill-import-max-skills-hint"
            className="w-full"
          />
          <p
            id="skill-import-max-skills-hint"
            className="text-xs font-normal leading-5 text-muted-foreground"
          >
            {t("skillImportMaxSkillsHint", {
              min: MIN_SKILL_IMPORT_SKILLS,
              max: MAX_SKILL_IMPORT_SKILLS,
            })}
          </p>
        </div>

        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <SubmitButton
            error={state.error}
            pendingLabel={t("saving")}
            savedLabel={t("saved")}
            variant="primary"
            size="md"
            className="w-full sm:w-auto"
          >
            <Save className="size-4" aria-hidden="true" />
            {t("saveChanges")}
          </SubmitButton>
          {state.error ? (
            <p className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          ) : null}
        </div>
      </form>
    </AdminPanel>
  );
}
