'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch } from 'lucide-react';
import { syncSkillRegistryAction, type SkillRegistrySyncActionState } from '@/lib/admin/market-actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

type Source = {
  owner: string;
  repo: string;
  ref: string;
  rootPath: string;
  slugPrefix: string;
};

export function SkillRegistrySync({ source }: { source: Source }) {
  const t = useTranslations('admin');
  const [state, formAction] = useActionState<SkillRegistrySyncActionState, FormData>(syncSkillRegistryAction, {});
  const field = 'h-9 rounded-md border border-zinc-200 px-2.5 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-900';

  return (
    <form action={formAction} className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-32">
          <label className="block text-xs font-medium text-zinc-500">{t('owner')}</label>
          <input name="owner" defaultValue={source.owner} className={`${field} w-32`} />
        </div>
        <div className="min-w-36">
          <label className="block text-xs font-medium text-zinc-500">{t('repo')}</label>
          <input name="repo" defaultValue={source.repo} className={`${field} w-36`} />
        </div>
        <div className="min-w-24">
          <label className="block text-xs font-medium text-zinc-500">{t('ref')}</label>
          <input name="ref" defaultValue={source.ref} className={`${field} w-24`} />
        </div>
        <div className="min-w-28">
          <label className="block text-xs font-medium text-zinc-500">{t('root')}</label>
          <input name="rootPath" defaultValue={source.rootPath} className={`${field} w-28`} />
        </div>
        <div className="min-w-24">
          <label className="block text-xs font-medium text-zinc-500">{t('prefix')}</label>
          <input name="slugPrefix" defaultValue={source.slugPrefix} className={`${field} w-24`} />
        </div>
        <SubmitButton
          pendingLabel={t('syncing')}
          savedLabel={t('synced')}
          error={state.error && !state.ok}
          className="inline-flex h-9 items-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          <GitBranch className="size-4" /> {t('syncTpSkills')}
        </SubmitButton>
      </div>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t('syncTpSkillsDescription')}</p>
      {state.ok ? (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
          {t('syncTpSkillsResult', {
            found: state.found ?? 0,
            created: state.created ?? 0,
            updated: state.updated ?? 0,
            failed: state.failed ?? 0,
          })}
        </p>
      ) : null}
      {state.error ? <p className="mt-2 text-xs text-red-600" role="alert">{state.error}</p> : null}
    </form>
  );
}
