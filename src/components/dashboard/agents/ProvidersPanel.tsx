'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import type { ReactNode } from 'react';
import {
  Braces,
  Cpu,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
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

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Cpu;
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        {label}
      </span>
      {children}
    </label>
  );
}

export function ProvidersPanel({ slug, providers }: { slug: string; providers: ProviderRow[] }) {
  const t = useTranslations('console.agents');
  const [state, formAction] = useActionState<ActionState, FormData>(createProviderAction, {});
  const [refreshState, refreshAction] = useActionState<ActionState, FormData>(refreshModelsAction, {});

  return (
    <div className="space-y-5 px-4 py-5 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('model')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('modelDescription')}</p>
      </div>

      <section className="ui-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">{t('addModelProvider')}</h2>
        </div>
        <form action={formAction} className="grid gap-3 px-5 py-5 xl:grid-cols-2">
          <input type="hidden" name="workspace" value={slug} />
          <Field icon={Cpu} label={t('name')}>
            <input name="name" required placeholder={t('openai')} className="ui-input h-10 w-full" />
          </Field>
          <Field icon={Braces} label={t('format')}>
            <select name="format" className="ui-input h-10 w-full" defaultValue="openai">
              <option value="openai">{t('openai')}</option>
              <option value="openai-responses">{t('openaiResponses')}</option>
              <option value="anthropic">{t('anthropic')}</option>
            </select>
          </Field>
          <Field icon={Link2} label={t('baseUrl')}>
            <input name="baseUrl" required placeholder="https://api.openai.com/v1" className="ui-input h-10 w-full" />
          </Field>
          <Field icon={KeyRound} label={t('apiKey')}>
            <input name="apiKey" required type="password" placeholder="sk-..." className="ui-input h-10 w-full" />
          </Field>
          <div className="xl:col-span-2">
            <SubmitButton
              error={state.error}
              pendingLabel={t('adding')}
              savedLabel={t('added')}
              className="ui-button-primary h-10 gap-2 px-4"
            >
              <Plus className="size-[18px] shrink-0" />
              {t('addProvider')}
            </SubmitButton>
            {state.error ? <p className="mt-2 text-sm text-red-600" role="alert">{state.error}</p> : null}
            <p className="mt-3 text-xs text-muted-foreground">
              {t('baseUrlMustIncludeTheVersionSegmentEg')} <code>/v1</code>{t('modelsAreFetchedFrom')} <code>{'{baseUrl}/models'}</code>.
            </p>
          </div>
        </form>
      </section>

      {refreshState.error ? <p className="text-sm text-red-600" role="alert">{refreshState.error}</p> : null}

      <section className="ui-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">{t('modelProviders')}</h2>
          <span className="inline-flex h-7 items-center rounded-md border border-border bg-muted/25 px-2.5 text-xs font-medium text-muted-foreground">
            {providers.length} {t('providers')}
          </span>
        </div>
        {providers.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Cpu className="mx-auto mb-3 size-8 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">{t('noProvidersYet')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('noProvidersYetAddOneAboveThenRefreshItsModels')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {providers.map((provider) => (
              <li key={provider.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <div className="flex size-10 items-center justify-center rounded-md border border-border bg-muted/25 text-muted-foreground">
                      <Cpu className="size-[18px]" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{provider.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{provider.baseUrl}</p>
                    </div>
                    <span className="inline-flex h-6 items-center rounded-md border border-border bg-background px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {provider.format}
                    </span>
                    <span className="inline-flex h-6 items-center rounded-md bg-accent px-2 text-[11px] font-semibold uppercase tracking-wide text-accent-foreground">
                      {provider.modelCount} {t('models')}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2.5 lg:justify-end">
                  <form action={refreshAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="providerId" value={provider.id} />
                    <SubmitButton
                      error={refreshState.error}
                      pendingLabel={t('refreshing')}
                      savedLabel={t('refreshed')}
                      className="ui-button-secondary h-10 gap-2 px-4 text-sm"
                    >
                      <RefreshCw className="size-[18px] shrink-0" />
                      {t('refreshModels')}
                    </SubmitButton>
                  </form>
                  <form action={deleteProviderAction}>
                    <input type="hidden" name="workspace" value={slug} />
                    <input type="hidden" name="providerId" value={provider.id} />
                    <button className="ui-button-secondary h-10 gap-2 px-4 text-sm text-red-600 dark:text-red-300">
                      <Trash2 className="size-[18px] shrink-0" />
                      {t('remove')}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
