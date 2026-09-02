'use client';

import { useActionState } from 'react';
import { Network, RotateCcw, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  updateRemoteMcpPrivateHostsSettingsAction,
  type AdminSettingsActionState,
} from '@/lib/admin/settings-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminBadge, AdminPanel } from '@/components/admin/AdminUI';

const MAX_PRIVATE_HOSTS_LENGTH = 8_192;

export function RemoteMcpPrivateHostsSettingsForm({
  value,
  source,
}: {
  value: string;
  source: 'database' | 'environment' | 'default';
}) {
  const t = useTranslations('admin');
  const [state, action, isPending] = useActionState<AdminSettingsActionState, FormData>(
    updateRemoteMcpPrivateHostsSettingsAction,
    {},
  );
  const sourceLabel = source === 'database'
    ? t('settingsSourceAdmin')
    : source === 'environment'
      ? t('settingsSourceEnvironment')
      : t('settingsSourceDefault');

  return (
    <AdminPanel
      title={t('remoteMcpPrivateHosts')}
      description={t('remoteMcpPrivateHostsDescription')}
      actions={<AdminBadge tone={source === 'database' ? 'brand' : 'neutral'}>{sourceLabel}</AdminBadge>}
    >
      <form action={action} className="space-y-5">
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/25 p-4">
          <Network className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm leading-6 text-muted-foreground">{t('remoteMcpPrivateHostsBehavior')}</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="remote-mcp-private-hosts" className="block text-sm font-medium text-foreground">
            {t('remoteMcpPrivateHostsLabel')}
          </label>
          <textarea
            id="remote-mcp-private-hosts"
            name="remoteMcpPrivateHosts"
            defaultValue={value}
            rows={4}
            maxLength={MAX_PRIVATE_HOSTS_LENGTH}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-describedby="remote-mcp-private-hosts-hint"
            className="ui-input min-h-28 w-full resize-y font-mono text-sm"
          />
          <p id="remote-mcp-private-hosts-hint" className="text-xs text-muted-foreground">
            {t('remoteMcpPrivateHostsHint')}
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
        {state.ok ? <p className="text-sm text-accent-foreground" aria-live="polite">{t('remoteMcpPrivateHostsSaved')}</p> : null}
      </form>
    </AdminPanel>
  );
}
