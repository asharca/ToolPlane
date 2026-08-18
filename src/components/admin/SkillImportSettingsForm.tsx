'use client';

import { useActionState } from 'react';
import { Save, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminPanel } from '@/components/admin/AdminUI';
import { updateSkillImportLimitAction } from '@/lib/admin/settings-actions';
import {
  MAX_SKILL_IMPORT_SKILLS,
  MIN_SKILL_IMPORT_SKILLS,
} from '@/lib/skills/limits';

export function SkillImportSettingsForm({ maxSkills }: { maxSkills: number }) {
  const [state, action] = useActionState(updateSkillImportLimitAction, {});
  const t = useTranslations('admin');

  return (
    <AdminPanel title={t('skillImports')} description={t('skillImportsDescription')}>
      <form action={action} className="max-w-2xl space-y-5">
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/25 p-4">
          <Upload className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm leading-6 text-muted-foreground">{t('skillImportsSafetyLimits')}</p>
        </div>

        <div className="max-w-sm space-y-1.5 text-sm font-medium text-foreground">
          <label htmlFor="skill-import-max-skills">{t('skillImportMaxSkills')}</label>
          <input
            id="skill-import-max-skills"
            name="skillImportMaxSkills"
            type="number"
            min={MIN_SKILL_IMPORT_SKILLS}
            max={MAX_SKILL_IMPORT_SKILLS}
            step="1"
            inputMode="numeric"
            required
            defaultValue={maxSkills}
            aria-describedby="skill-import-max-skills-hint"
            className="ui-input h-11 w-full"
          />
          <p id="skill-import-max-skills-hint" className="text-xs font-normal leading-5 text-muted-foreground">
            {t('skillImportMaxSkillsHint', {
              min: MIN_SKILL_IMPORT_SKILLS,
              max: MAX_SKILL_IMPORT_SKILLS,
            })}
          </p>
        </div>

        <div className="flex flex-col items-start gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
          <SubmitButton
            error={state.error}
            pendingLabel={t('saving')}
            savedLabel={t('saved')}
            className="ui-button-primary h-11 w-full sm:w-auto"
          >
            <Save className="size-4" aria-hidden="true" />
            {t('saveChanges')}
          </SubmitButton>
          {state.error ? <p className="text-sm text-destructive-text" role="alert">{state.error}</p> : null}
        </div>
      </form>
    </AdminPanel>
  );
}
