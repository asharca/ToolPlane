'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, GitBranch, RotateCcw } from 'lucide-react';
import { syncSkillRegistryAction, type SkillRegistrySyncActionState } from '@/lib/admin/market-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { AdminPanel } from '@/components/admin/AdminUI';

type Source = {
  owner: string;
  repo: string;
  ref: string;
  rootPath: string;
  slugPrefix: string;
};

export function SkillRegistrySync({ source }: { source: Source }) {
  const t = useTranslations('admin');
  const ops = useTranslations('adminOps');
  const [state, formAction, pending] = useActionState<SkillRegistrySyncActionState, FormData>(syncSkillRegistryAction, {});

  return (
    <AdminPanel title={t('syncTpSkills')} description={t('syncTpSkillsDescription')}>
      <form action={formAction} className="space-y-4">
        <fieldset disabled={pending} className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-2">
            <span>{t('owner')}</span>
            <input
              name="owner"
              defaultValue={source.owner}
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-2">
            <span>{t('repo')}</span>
            <input
              name="repo"
              defaultValue={source.repo}
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-2">
            <span>{t('ref')}</span>
            <input
              name="ref"
              defaultValue={source.ref}
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-3">
            <span>{t('root')}</span>
            <input
              name="rootPath"
              defaultValue={source.rootPath}
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium text-muted-foreground lg:col-span-1">
            <span>{t('prefix')}</span>
            <input
              name="slugPrefix"
              defaultValue={source.slugPrefix}
              className="ui-input h-11 font-mono"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <SubmitButton
            pendingLabel={t('syncing')}
            savedLabel={t('synced')}
            error={state.error && !state.ok}
            className="ui-button-primary h-11 w-full self-end lg:col-span-2"
          >
            <GitBranch className="size-4" />
            {t('syncTpSkills')}
          </SubmitButton>
        </fieldset>
        {state.ok ? (
          <p className="flex items-start gap-2 text-sm text-accent-foreground" aria-live="polite">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              {t('syncTpSkillsResult', {
                found: state.found ?? 0,
                created: state.created ?? 0,
                updated: state.updated ?? 0,
                failed: state.failed ?? 0,
              })}
            </span>
          </p>
        ) : null}
        {state.error ? (
          <p className="flex items-start gap-2 text-sm text-destructive-text" role="alert">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </p>
        ) : null}
        {state.failures?.length ? <section className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{ops('failedFiles')} ({state.failures.length})</h3><button type="submit" name="intent" value="retry" disabled={pending} className="ui-button-secondary"><RotateCcw className="size-4" />{pending ? t('syncing') : ops('retryFailed')}</button></div>
          <p className="break-all font-mono text-xs text-muted-foreground">{state.source?.owner}/{state.source?.repo} @ {state.source?.ref}</p>
          <ul className="max-h-80 divide-y divide-border overflow-auto">{state.failures.map((failure) => <li key={failure.path} className="py-3"><code className="block break-all text-xs font-medium">{failure.path}</code><p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive-text">{failure.error}</p></li>)}</ul>
        </section> : null}
      </form>
    </AdminPanel>
  );
}
