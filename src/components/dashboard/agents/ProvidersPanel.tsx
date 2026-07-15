'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import {
  Braces,
  Cpu,
  Eye,
  FlaskConical,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import {
  createProviderAction,
  deleteProviderAction,
  refreshModelsAction,
  testProviderModelAction,
  updateProviderAction,
  type ActionState,
} from '@/lib/agents/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

export type ProviderRow = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  modelCount: number;
  models: string[];
  modelsFetchedAt: string | null;
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

function ActionMessage({ state }: { state: ActionState }) {
  if (state.error) {
    return <p className="mt-2 text-sm text-red-600" role="alert">{state.error}</p>;
  }
  if (state.warning) {
    return <p className="mt-2 text-sm text-amber-600 dark:text-amber-300" role="alert">{state.warning}</p>;
  }
  return null;
}

function DialogShell({
  open,
  onClose,
  title,
  titleId,
  maxWidth = 'max-w-xl',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  maxWidth?: string;
  children: ReactNode;
}) {
  const t = useTranslations('console.agents');
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[calc(100vh-2rem)] w-full ${maxWidth} overflow-hidden rounded-xl border border-border bg-card shadow-xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            title={t('close')}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="max-h-[calc(100vh-7rem)] overflow-y-auto">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AddProviderDialog({ slug }: { slug: string }) {
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(createProviderAction, {});

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="ui-button-primary h-10 gap-2 px-4">
        <Plus className="size-[18px] shrink-0" />
        {t('addProvider')}
      </button>

      <DialogShell
        open={open}
        onClose={() => setOpen(false)}
        title={t('addModelProvider')}
        titleId="add-provider-title"
      >
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
            <p className="text-xs text-muted-foreground">
              {t('baseUrlMustIncludeTheVersionSegmentEg')} <code>/v1</code>{t('modelsAreFetchedFrom')} <code>{'{baseUrl}/models'}</code>.
            </p>
            <ActionMessage state={state} />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="ui-button-secondary h-10 px-4 text-sm">
                {t('cancel')}
              </button>
              <SubmitButton
                error={state.error}
                pendingLabel={t('adding')}
                savedLabel={t('added')}
                className="ui-button-primary h-10 gap-2 px-4"
              >
                <Plus className="size-[18px] shrink-0" />
                {t('addProvider')}
              </SubmitButton>
            </div>
          </div>
        </form>
      </DialogShell>
    </>
  );
}

function ModelTestRow({ slug, providerId, model }: { slug: string; providerId: string; model: string }) {
  const t = useTranslations('console.agents');
  const [state, testAction] = useActionState<ActionState, FormData>(testProviderModelAction, {});

  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{model}</span>
        <form action={testAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="providerId" value={providerId} />
          <input type="hidden" name="model" value={model} />
          <SubmitButton
            error={state.error}
            pendingLabel={t('testing')}
            savedLabel={t('available')}
            className="ui-button-secondary h-8 gap-1.5 px-2.5 text-xs"
          >
            <FlaskConical className="size-3.5 shrink-0" />
            {t('testModel')}
          </SubmitButton>
        </form>
      </div>
      {state.error ? (
        <ActionMessage state={state} />
      ) : state.savedAt ? (
        <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-300" role="status">{t('modelAvailable')}</p>
      ) : null}
    </div>
  );
}

function ViewModelsDialog({ slug, provider }: { slug: string; provider: ProviderRow }) {
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="ui-button-secondary h-10 gap-2 px-4 text-sm">
        <Eye className="size-[18px] shrink-0" />
        {t('viewModels')}
      </button>

      <DialogShell
        open={open}
        onClose={() => setOpen(false)}
        title={t('viewModels')}
        titleId={`provider-models-${provider.id}`}
        maxWidth="max-w-4xl"
      >
        <div className="space-y-4 px-5 py-5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{provider.name}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{provider.baseUrl}</p>
            {provider.modelsFetchedAt ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('lastRefreshedAt', { date: provider.modelsFetchedAt })}
              </p>
            ) : null}
          </div>
          {provider.models.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {provider.models.map((model) => (
                <ModelTestRow key={model} slug={slug} providerId={provider.id} model={model} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noModelsCachedYet')}</p>
          )}
        </div>
      </DialogShell>
    </>
  );
}

function EditProviderDialog({ slug, provider }: { slug: string; provider: ProviderRow }) {
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [updateState, updateAction] = useActionState<ActionState, FormData>(updateProviderAction, {});

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="ui-button-secondary h-10 gap-2 px-4 text-sm">
        <Pencil className="size-[18px] shrink-0" />
        {t('editProvider')}
      </button>

      <DialogShell
        open={open}
        onClose={() => setOpen(false)}
        title={t('editProvider')}
        titleId={`edit-provider-${provider.id}`}
        maxWidth="max-w-2xl"
      >
        <form action={updateAction} className="grid gap-3 px-5 py-5 xl:grid-cols-2">
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="providerId" value={provider.id} />
          <Field icon={Cpu} label={t('name')}>
            <input name="name" required defaultValue={provider.name} className="ui-input h-10 w-full" />
          </Field>
          <Field icon={Braces} label={t('format')}>
            <select name="format" className="ui-input h-10 w-full" defaultValue={provider.format}>
              <option value="openai">{t('openai')}</option>
              <option value="openai-responses">{t('openaiResponses')}</option>
              <option value="anthropic">{t('anthropic')}</option>
            </select>
          </Field>
          <Field icon={Link2} label={t('baseUrl')}>
            <input name="baseUrl" required defaultValue={provider.baseUrl} className="ui-input h-10 w-full" />
          </Field>
          <Field icon={KeyRound} label={t('apiKey')}>
            <input
              name="apiKey"
              type="password"
              placeholder={t('leaveBlankToKeepCurrentKey')}
              className="ui-input h-10 w-full"
            />
          </Field>
          <div className="xl:col-span-2">
            <ActionMessage state={updateState} />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="ui-button-secondary h-10 px-4 text-sm">
                {t('cancel')}
              </button>
              <SubmitButton
                error={updateState.error}
                pendingLabel={t('saving')}
                savedLabel={t('saved')}
                className="ui-button-primary h-10 gap-2 px-4"
              >
                <Save className="size-[18px] shrink-0" />
                {t('saveChanges')}
              </SubmitButton>
            </div>
          </div>
        </form>
      </DialogShell>
    </>
  );
}

function ProviderCard({ slug, provider }: { slug: string; provider: ProviderRow }) {
  const t = useTranslations('console.agents');
  const [refreshState, refreshAction] = useActionState<ActionState, FormData>(refreshModelsAction, {});

  return (
    <li className="grid gap-3 px-5 py-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
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
          <ViewModelsDialog slug={slug} provider={provider} />
          <EditProviderDialog slug={slug} provider={provider} />
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
            <button
              type="submit"
              onClick={(event) => {
                if (!window.confirm(t('removeProviderPrompt', { name: provider.name }))) {
                  event.preventDefault();
                }
              }}
              className="ui-button-secondary h-10 gap-2 px-4 text-sm text-red-600 dark:text-red-300"
            >
              <Trash2 className="size-[18px] shrink-0" />
              {t('remove')}
            </button>
          </form>
        </div>
      </div>
      <ActionMessage state={refreshState} />
    </li>
  );
}

export function ProvidersPanel({ slug, providers }: { slug: string; providers: ProviderRow[] }) {
  const t = useTranslations('console.agents');

  return (
    <div className="space-y-5 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{t('model')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('modelDescription')}</p>
        </div>
        <AddProviderDialog slug={slug} />
      </div>

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
              <ProviderCard key={provider.id} slug={slug} provider={provider} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
