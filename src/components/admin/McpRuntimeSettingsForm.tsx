'use client';
import { Input } from '@/components/motion/input';
import { Button } from '@/components/motion/button';


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
      actions={<AdminBadge tone={source === 'database' ? 'info' : 'neutral'}>{sourceLabel}</AdminBadge>}
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
            <Input id="mcp-startup-idle-timeout" name="mcpStartupIdleTimeoutSeconds" type="number" min={minTimeoutSeconds} max={maxTimeoutSeconds} step={1} inputMode="numeric" required defaultValue={String(Math.round(idleTimeoutMs / 1_000))} aria-describedby="mcp-startup-timeout-help" className="w-full" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="mcp-startup-max-timeout" className="block text-sm font-medium text-foreground">
              {t('mcpStartupMaxTimeout')}
            </label>
            <Input id="mcp-startup-max-timeout" name="mcpStartupMaxTimeoutSeconds" type="number" min={minTimeoutSeconds} max={maxTimeoutSeconds} step={1} inputMode="numeric" required defaultValue={String(Math.round(maxTimeoutMs / 1_000))} aria-describedby="mcp-startup-timeout-help" className="w-full" />
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
            variant="primary" size="md"
          >
            <Save className="size-4" />
            {t('saveChanges')}
          </SubmitButton>
          {source === 'database' ? (
            <Button type="submit" name="intent" value="reset" formNoValidate disabled={isPending} variant="secondary" size="md"><RotateCcw className="size-4" />
            {t('restoreEnvironmentDefault')}</Button>
          ) : null}
        </div>

        {state.error ? <p className="text-sm text-destructive" role="alert">{state.error}</p> : null}
        {state.ok ? <p className="text-sm text-accent-foreground" aria-live="polite">{t('saved')}</p> : null}
      </form>
    </AdminPanel>
  );
}
