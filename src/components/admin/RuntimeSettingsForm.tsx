'use client';

import { useActionState } from 'react';
import { HardDriveUpload, RotateCcw, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  updateAgentAttachmentLimitAction,
  type AdminSettingsActionState,
} from '@/lib/admin/settings-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';

export function RuntimeSettingsForm({
  bytes,
  source,
  minMegabytes,
  maxMegabytes,
}: {
  bytes: number;
  source: 'database' | 'environment' | 'default';
  minMegabytes: number;
  maxMegabytes: number;
}) {
  const t = useTranslations('admin');
  const [state, action, isPending] = useActionState<AdminSettingsActionState, FormData>(
    updateAgentAttachmentLimitAction,
    {},
  );
  const megabytes = Math.max(1, Math.round(bytes / 1_000_000));
  const sourceLabel = source === 'database'
    ? t('settingsSourceAdmin')
    : source === 'environment'
      ? t('settingsSourceEnvironment')
      : t('settingsSourceDefault');

  return (
    <AdminPanel
      title={t('agentAttachmentUploads')}
      description={t('agentAttachmentUploadsDescription')}
      actions={<AdminBadge tone={source === 'database' ? 'brand' : 'neutral'}>{sourceLabel}</AdminBadge>}
    >
      <form action={action} className="space-y-5">
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/25 p-4">
          <HardDriveUpload className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-foreground">{t('attachmentStorageBehavior')}</p>
            <p className="mt-1 text-muted-foreground">{t('attachmentStorageBehaviorDescription')}</p>
          </div>
        </div>

        <div className="max-w-md space-y-1.5">
          <label htmlFor="max-agent-attachment-size" className="block text-sm font-medium text-foreground">
            {t('maximumAttachmentSize')}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="max-agent-attachment-size"
              name="maxAttachmentSizeMb"
              type="number"
              min={minMegabytes}
              max={maxMegabytes}
              step={1}
              defaultValue={megabytes}
              aria-describedby="max-agent-attachment-size-help"
              className="ui-input h-11 min-w-0 flex-1 font-mono tabular-nums"
              required
            />
            <span className="text-sm text-muted-foreground">MB</span>
          </div>
          <p id="max-agent-attachment-size-help" className="text-xs text-muted-foreground">
            {t('maximumAttachmentSizeHelp', { bytes: bytes.toLocaleString() })}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <SubmitButton
            pendingLabel={t('saving')}
            savedLabel={t('saved')}
            error={state.error}
            className="ui-button-primary h-11"
          >
            <Save className="size-4" />
            {t('saveChanges')}
          </SubmitButton>
          {source === 'database' ? (
            <button
              type="submit"
              name="intent"
              value="reset"
              formNoValidate
              disabled={isPending}
              className="ui-button-secondary h-11"
            >
              <RotateCcw className="size-4" />
              {t('restoreEnvironmentDefault')}
            </button>
          ) : null}
        </div>

        {state.error ? <p className="text-sm text-destructive-text" role="alert">{state.error}</p> : null}
        {state.ok ? <p className="text-sm text-accent-foreground" aria-live="polite">{t('runtimeSettingsSaved')}</p> : null}
      </form>
    </AdminPanel>
  );
}
