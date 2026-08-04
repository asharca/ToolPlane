'use client';

import { useActionState } from 'react';
import { Save, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { updateHermesArchiveUploadLimitAction } from '@/lib/admin/settings-actions';
import {
  MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
  MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
} from '@/lib/agents/hermes/archive-limits';

export function SystemSettingsForm({
  hermesArchiveMaxUploadMiB,
}: {
  hermesArchiveMaxUploadMiB: number;
}) {
  const [state, formAction] = useActionState(updateHermesArchiveUploadLimitAction, {});
  const t = useTranslations('admin');

  return (
    <form action={formAction} className="max-w-2xl space-y-5">
      <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-amber-500/25 bg-background text-amber-700 dark:text-amber-300">
            <Upload className="size-4" aria-hidden="true" />
          </span>
          <p className="text-sm leading-6 text-foreground">{t('hermesArchiveSafetyLimits')}</p>
        </div>
      </div>

      <div className="max-w-sm space-y-1.5 text-sm font-medium text-foreground">
        <label htmlFor="hermes-archive-max-upload-mib">
          {t('hermesArchiveMaxUploadMiB')}
        </label>
        <input
          id="hermes-archive-max-upload-mib"
          name="hermesArchiveMaxUploadMiB"
          type="number"
          min={MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB}
          max={MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB}
          step="1"
          inputMode="numeric"
          required
          defaultValue={hermesArchiveMaxUploadMiB}
          aria-describedby="hermes-archive-max-upload-mib-hint"
          className="ui-input h-11 w-full"
        />
        <p
          id="hermes-archive-max-upload-mib-hint"
          className="text-xs font-normal leading-5 text-muted-foreground"
        >
          {t('hermesArchiveMaxUploadMiBHint', {
            min: MIN_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
            max: MAX_HERMES_ARCHIVE_MAX_UPLOAD_MIB,
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
        {state.error ? (
          <p className="text-sm text-destructive-text" role="alert">{state.error}</p>
        ) : null}
      </div>
    </form>
  );
}
