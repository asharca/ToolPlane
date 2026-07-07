'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import {
  createProviderAction,
  deleteProviderAction,
  refreshModelsAction,
  type ActionState,
} from '@/lib/agents/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export type ProviderRow = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  modelCount: number;
};

const input =
  'h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';

export function ProvidersPanel({ slug, providers }: { slug: string; providers: ProviderRow[] }) {
  const t = useTranslations('console.agents');
  const [state, formAction] = useActionState<ActionState, FormData>(createProviderAction, {});
  const [refreshState, refreshAction] = useActionState<ActionState, FormData>(refreshModelsAction, {});

  return (
    <div className="px-8 py-6">
      <form action={formAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <input type="hidden" name="workspace" value={slug} />
        <label className="space-y-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {t('name')}
          <input name="name" required placeholder={t('openai')} className={input} />
        </label>
        <label className="space-y-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {t('format')}
          <select name="format" className={input} defaultValue="openai">
            <option value="openai">{t('openai')}</option>
            <option value="anthropic">{t('anthropic')}</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {t('baseUrl')}
          <input name="baseUrl" required placeholder="https://api.openai.com/v1" className={input} />
        </label>
        <label className="space-y-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {t('apiKey')}
          <input name="apiKey" required type="password" placeholder="sk-…" className={input} />
        </label>
        <SubmitButton
          error={state.error}
          pendingLabel={t('adding')}
          savedLabel={t('added')}
          className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {t('addProvider')}
        </SubmitButton>
      </form>
      {state.error ? <p className="mt-2 text-sm text-red-600" role="alert">{state.error}</p> : null}
      {refreshState.error ? <p className="mt-2 text-sm text-red-600" role="alert">{refreshState.error}</p> : null}

      <p className="mt-2 text-xs text-muted-foreground">
        {t('baseUrlMustIncludeTheVersionSegmentEg')} <code>/v1</code>{t('modelsAreFetchedFrom')} <code>{'{baseUrl}/models'}</code>.
      </p>

      <ul className="mt-5 divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {providers.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {t('noProvidersYetAddOneAboveThenRefreshItsModels')}
          </li>
        ) : (
          providers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {p.name}
                  <span className="ml-2 rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] font-medium uppercase text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    {p.format}
                  </span>
                </p>
                <p className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {p.baseUrl} · {p.modelCount} {t('models')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <form action={refreshAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="providerId" value={p.id} />
                  <SubmitButton
                    error={refreshState.error}
                    pendingLabel={t('refreshing')}
                    savedLabel={t('refreshed')}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> {t('refreshModels')}
                  </SubmitButton>
                </form>
                <form action={deleteProviderAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="providerId" value={p.id} />
                  <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-zinc-800 dark:text-red-400 dark:hover:bg-red-950/30">
                    <Trash2 className="h-3.5 w-3.5" /> {t('remove')}
                  </button>
                </form>
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
