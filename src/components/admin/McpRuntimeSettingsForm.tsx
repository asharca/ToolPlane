'use client';

import { useActionState } from 'react';
import { Clock3, RotateCcw, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  updateMcpStartupTimeoutSettingsAction,
  type AdminSettingsActionState,
} from '@/lib/admin/settings-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';

export function McpRuntimeSettingsForm({
  idleTimeoutMs,
  maxTimeoutMs,
  source,
  minTimeoutSeconds,
  maxTimeoutSeconds,
}: {
  idleTimeoutMs: number;
  maxTimeoutMs: number;
  source: 'database' | 'environment' | 'default';
  minTimeoutSeconds: number;
  maxTimeoutSeconds: number;
}) {
  const t = useTranslations('admin');
  const [state, action, isPending] = useActionState<AdminSettingsActionState, FormData>(
    updateMcpStartupTimeoutSettingsAction,
    {},
  );
  const sourceLabel = source === 'database'
    ? t('settingsSourceAdmin')
    : source === 'environment'
      ? t('settingsSourceEnvironment')
      : t('settingsSourceDefault');

  return (
    <AdminPanel
      title={t('mcpStartupTimeouts')}
      description={t('mcpStartupTimeoutsDescription')}
      actions={<AdminBadge tone={source === 'database' ? 'brand' : 'neutral'}>{sourceLabel}</AdminBadge>}
    >
      <form action={action} className="space-y-5">
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/25 p-4">
          <Clock3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm leading-6 text-muted-foreground">{t('mcpStartupTimeoutsBehavior')}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="mcp-startup-idle-timeout" className="block text-sm font-medium text-foreground">
              {t('mcpStartupIdleTimeout')}
            </label>
            <input
              id="mcp-startup-idle-timeout"
              name="mcpStartupIdleTimeoutSeconds"
              type="number"
              min={minTimeoutSeconds}
              max={maxTimeoutSeconds}
              step={1}
              inputMode="numeric"
              required
              defaultValue={Math.round(idleTimeoutMs / 1_000)}
              aria-describedby="mcp-startup-timeout-help"
              className="ui-input h-11 w-full font-mono tabular-nums"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="mcp-startup-max-timeout" className="block text-sm font-medium text-foreground">
              {t('mcpStartupMaxTimeout')}
            </label>
            <input
              id="mcp-startup-max-timeout"
              name="mcpStartupMaxTimeoutSeconds"
              type="number"
              min={minTimeoutSeconds}
              max={maxTimeoutSeconds}
              step={1}
              inputMode="numeric"
              required
              defaultValue={Math.round(maxTimeoutMs / 1_000)}
              aria-describedby="mcp-startup-timeout-help"
              className="ui-input h-11 w-full font-mono tabular-nums"
            />
          </div>
        </div>
        <p id="mcp-startup-timeout-help" className="text-xs text-muted-foreground">
          {t('mcpStartupTimeoutsHint', { min: minTimeoutSeconds, max: maxTimeoutSeconds })}
        </p>

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
