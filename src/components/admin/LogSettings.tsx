'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button, Input } from '@asharca/ui';
import { ChevronDown, CircleStop, Clock3, Play, Save, Settings } from 'lucide-react';
import { updateLogSettings } from '@/lib/admin/log-actions';
import type { LogSettings as SettingsValue } from '@/lib/observability/settings';

export function LogSettings({ settings }: { settings: SettingsValue }) {
  const t = useTranslations('admin');
  const [state, action, pending] = useActionState(updateLogSettings, {});
  return <details id="log-settings" className="group border-t border-border pt-4">
    <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
      <Settings className="size-4 text-muted-foreground" aria-hidden="true" />{t('logsSettings')}
      {settings.captures.length ? <Badge tone="warning">{t('logsActiveCaptures', { count: settings.captures.length })}</Badge> : null}
      <ChevronDown className="ml-auto size-4 text-muted-foreground group-open:rotate-180" aria-hidden="true" />
    </summary>
    <fieldset disabled={pending} className="min-w-0 disabled:opacity-60">
      <div className="grid gap-6 py-5 xl:grid-cols-2">
        <form action={action} className="min-w-0 space-y-4">
          <h3 className="text-sm font-medium">{t('logsRetention')}</h3>
          <input type="hidden" name="intent" value="retention" />
          <div className="grid gap-3 sm:grid-cols-3">
            {(['eventDays', 'detailDays', 'auditDays'] as const).map((key) => <label key={key} className="grid min-w-0 gap-1.5 text-xs font-medium">
              {t(`logs_${key}`)}<Input className="h-10 w-full tabular-nums" type="number" required name={key} min={key === 'auditDays' ? 30 : 1}
                max={key === 'detailDays' ? 30 : key === 'eventDays' ? 365 : 3650} defaultValue={settings[key]} />
            </label>)}
          </div>
          <Button type="submit" variant="secondary"><Save className="size-4" aria-hidden="true" />{pending ? t('saving') : t('logsSave')}</Button>
        </form>
        <form action={action} className="min-w-0 space-y-4 border-t border-border pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
          <h3 className="text-sm font-medium">{t('logsDiagnosticCapture')}</h3>
          <input type="hidden" name="intent" value="capture" />
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <label className="grid min-w-0 gap-1.5 text-xs font-medium">{t('logsCapture')}
              <select name="field" className="ui-input h-10 w-full">{['workspaceId', 'deploymentId', 'agentId'].map((key) => <option key={key} value={key}>{t(`logFields.${key}`)}</option>)}</select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-xs font-medium">{t('logsResource')}<Input name="id" required maxLength={200} placeholder="ID" className="h-10 w-full font-mono" /></label>
          </div>
          <Button type="submit" variant="secondary"><Play className="size-4" aria-hidden="true" />{t('logsStartCapture')}</Button>
        </form>
      </div>
      {settings.captures.length ? <div className="space-y-3 border-t border-border py-4">
        <ul className="divide-y divide-border">{settings.captures.map((item) => <li key={`${item.field}:${item.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-xs">
          <Badge tone="warning">{t('logsCapturing')}</Badge>
          <span className="min-w-0 flex-1 break-all font-mono">{t(`logFields.${item.field}`)}: {item.id}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground"><Clock3 className="size-3.5" aria-hidden="true" />{t('logsExpires')}: {item.expiresAt}</span>
        </li>)}</ul>
        <form action={action}><input type="hidden" name="intent" value="stop" /><Button type="submit" variant="secondary"><CircleStop className="size-4" aria-hidden="true" />{t('logsStopCapture')}</Button></form>
      </div> : null}
    </fieldset>
    {state.error ? <Alert tone="danger" className="mt-3">{state.error}</Alert> : state.ok ? <Alert tone="success" role="status" className="mt-3">{t('saved')}</Alert> : null}
  </details>;
}
