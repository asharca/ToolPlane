'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Braces,
  Cpu,
  FlaskConical,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
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
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';
import { NativeSelect } from '@/components/ui/NativeSelect';

export type ProviderRow = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  modelCount: number;
  models: string[];
  modelsFetchedAt: string | null;
};

type ProviderPreset = { format: string; name: string; baseUrl: string };

const customProviderPresets: ProviderPreset[] = [
  { format: 'openai', name: 'OpenAI-compatible', baseUrl: '' },
  { format: 'openai-responses', name: 'OpenAI Responses-compatible', baseUrl: '' },
  { format: 'anthropic', name: 'Anthropic-compatible', baseUrl: '' },
];

function Field({
  icon: Icon,
  label,
  children,
  hint,
}: {
  icon: typeof Cpu;
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs leading-5 text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function providerEndpoint(provider: ProviderRow, presets: ProviderPreset[], fallback: string) {
  return provider.baseUrl || presets.find((preset) => preset.format === provider.format)?.baseUrl || fallback;
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

const dialogWidths = {
  'max-w-xl': '!max-w-xl',
  'max-w-2xl': '!max-w-2xl',
} as const;

function ProviderDialog({
  open,
  onOpenChange,
  trigger,
  title,
  maxWidth = 'max-w-xl',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  title: string;
  maxWidth?: keyof typeof dialogWidths;
  children: ReactNode;
}) {
  const t = useTranslations('console.agents');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogPortal>
        <DialogOverlay className="!bg-black/40" />
        <DialogContent
          aria-describedby={undefined}
          className={`!block !max-h-[calc(100vh-2rem)] !w-full ${dialogWidths[maxWidth]} !gap-0 !overflow-hidden !p-0 shadow-xl`}
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <DialogTitle className="!text-sm !leading-normal !tracking-normal text-foreground">{title}</DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                aria-label={t('close')}
                title={t('close')}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-5" />
              </button>
            </DialogClose>
          </div>
          <div className="max-h-[calc(100vh-7rem)] overflow-y-auto">
            {children}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function ProviderFormatOptions({ piProviderPresets }: { piProviderPresets: ProviderPreset[] }) {
  return (
    <>
      <optgroup label="Pi providers">
        {piProviderPresets.map((preset) => <option key={preset.format} value={preset.format}>{preset.name}</option>)}
      </optgroup>
      <optgroup label="Custom">
        {customProviderPresets.map((preset) => <option key={preset.format} value={preset.format}>{preset.name}</option>)}
      </optgroup>
    </>
  );
}

function AddProviderDialog({
  slug,
  piProviderPresets,
  iconOnly = false,
}: {
  slug: string;
  piProviderPresets: ProviderPreset[];
  iconOnly?: boolean;
}) {
  const initialPreset = piProviderPresets[0] ?? customProviderPresets[0];
  const presets = [...piProviderPresets, ...customProviderPresets];
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState(initialPreset.format);
  const [name, setName] = useState(initialPreset.name);
  const [baseUrl, setBaseUrl] = useState('');
  const selectedPreset = presets.find((preset) => preset.format === format);
  const isCustomProvider = !format.startsWith('pi:');
  const [state, formAction] = useActionState<ActionState, FormData>(createProviderAction, {});

  return (
    <ProviderDialog
      open={open}
      onOpenChange={setOpen}
      title={t('addModelProvider')}
      trigger={(
        <button
          type="button"
          aria-label={t('addProvider')}
          title={t('addProvider')}
          className={iconOnly ? 'ui-button-ghost ui-icon-button' : 'ui-button-primary h-10 gap-2 px-4'}
        >
          <Plus className="size-[18px] shrink-0" />
          {iconOnly ? null : t('addProvider')}
        </button>
      )}
    >
        <form action={formAction} className="grid gap-3 px-5 py-5 xl:grid-cols-2">
          <input type="hidden" name="workspace" value={slug} />
          <Field icon={Cpu} label={t('name')}>
            <input name="name" required value={name} onChange={(event) => setName(event.target.value)} className="ui-input h-10 w-full" />
          </Field>
          <Field icon={Braces} label={t('format')}>
            <NativeSelect
              name="format"
              className="ui-input h-10 w-full"
              value={format}
              onChange={(event) => {
                const preset = presets.find((candidate) => candidate.format === event.target.value);
                setFormat(event.target.value);
                if (preset) {
                  setName(preset.name);
                  setBaseUrl('');
                }
              }}
            >
              <ProviderFormatOptions piProviderPresets={piProviderPresets} />
            </NativeSelect>
          </Field>
              <Field
                icon={Link2}
                label={t('baseUrl')}
                hint={!isCustomProvider && selectedPreset?.baseUrl
                  ? t('leaveBlankToUseDefaultEndpoint', { endpoint: selectedPreset.baseUrl })
                  : undefined}
              >
                <input
                  name="baseUrl"
                  required={isCustomProvider}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={!isCustomProvider ? selectedPreset?.baseUrl : undefined}
                  className="ui-input h-10 w-full"
                />
              </Field>
          <div className={isCustomProvider ? undefined : 'xl:col-span-2'}>
            <Field icon={KeyRound} label={t('apiKey')}>
              <input name="apiKey" type="password" placeholder="API key or token" className="ui-input h-10 w-full" />
            </Field>
          </div>
          <div className="xl:col-span-2">
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
    </ProviderDialog>
  );
}

function ModelTestRow({ slug, providerId, model }: { slug: string; providerId: string; model: string }) {
  const t = useTranslations('console.agents');
  const [state, testAction] = useActionState<ActionState, FormData>(testProviderModelAction, {});

  return (
    <div className="rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted/60">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground">
            {model.charAt(0).toUpperCase() || 'M'}
          </span>
          <span className="truncate text-sm text-foreground" title={model}>{model}</span>
        </div>
        <form action={testAction}>
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="providerId" value={providerId} />
          <input type="hidden" name="model" value={model} />
          <SubmitButton
            error={state.error}
            pendingLabel={t('testing')}
            savedLabel={t('available')}
            ariaLabel={t('testModel')}
            title={t('testModel')}
            className="ui-button-ghost h-8 min-h-8 w-8 px-0 text-muted-foreground"
          >
            <FlaskConical className="size-3.5" />
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

function EditProviderDialog({
  slug,
  provider,
  piProviderPresets,
}: {
  slug: string;
  provider: ProviderRow;
  piProviderPresets: ProviderPreset[];
}) {
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState(provider.format);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const selectedPreset = piProviderPresets.find((preset) => preset.format === format);
  const isCustomProvider = !format.startsWith('pi:');
  const [updateState, updateAction] = useActionState<ActionState, FormData>(updateProviderAction, {});

  return (
    <ProviderDialog
      open={open}
      onOpenChange={setOpen}
      title={t('editProvider')}
      maxWidth="max-w-2xl"
      trigger={(
        <button
          type="button"
          aria-label={t('editProvider')}
          title={t('editProvider')}
          className="ui-button-ghost ui-icon-button"
        >
          <Pencil className="size-[18px]" />
        </button>
      )}
    >
        <form action={updateAction} className="grid gap-3 px-5 py-5 xl:grid-cols-2">
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="providerId" value={provider.id} />
          <Field icon={Cpu} label={t('name')}>
            <input name="name" required defaultValue={provider.name} className="ui-input h-10 w-full" />
          </Field>
          <Field
            icon={Braces}
            label={t('format')}
          >
            <NativeSelect name="format" className="ui-input h-10 w-full" value={format} onChange={(event) => {
              setFormat(event.target.value);
              setBaseUrl('');
            }}>
              <ProviderFormatOptions piProviderPresets={piProviderPresets} />
            </NativeSelect>
          </Field>
          <Field
            icon={Link2}
            label={t('baseUrl')}
            hint={!isCustomProvider && selectedPreset?.baseUrl
              ? t('leaveBlankToUseDefaultEndpoint', { endpoint: selectedPreset.baseUrl })
              : undefined}
          >
            <input
              name="baseUrl"
              required={isCustomProvider}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={!isCustomProvider ? selectedPreset?.baseUrl : undefined}
              className="ui-input h-10 w-full"
            />
          </Field>
          <div className={isCustomProvider ? undefined : 'xl:col-span-2'}>
            <Field icon={KeyRound} label={t('apiKey')}>
              <input
                name="apiKey"
                type="password"
                placeholder={t('leaveBlankToKeepCurrentKey')}
                className="ui-input h-10 w-full"
              />
            </Field>
          </div>
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
    </ProviderDialog>
  );
}

function ProviderDetail({
  slug,
  provider,
  piProviderPresets,
}: {
  slug: string;
  provider: ProviderRow;
  piProviderPresets: ProviderPreset[];
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const [modelQuery, setModelQuery] = useState('');
  const [refreshState, refreshAction] = useActionState<ActionState, FormData>(refreshModelsAction, {});
  const endpoint = providerEndpoint(provider, piProviderPresets, t('builtInConnection'));
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return query
      ? provider.models.filter((model) => model.toLocaleLowerCase().includes(query))
      : provider.models;
  }, [modelQuery, provider.models]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold text-muted-foreground">
            {provider.name.charAt(0).toUpperCase() || 'P'}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold text-foreground">{provider.name}</h2>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                {provider.format}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={endpoint}>{endpoint}</p>
            {provider.modelsFetchedAt ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('lastRefreshedAt', { date: provider.modelsFetchedAt })}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <EditProviderDialog slug={slug} provider={provider} piProviderPresets={piProviderPresets} />
          <form action={deleteProviderAction}>
            <input type="hidden" name="workspace" value={slug} />
            <input type="hidden" name="providerId" value={provider.id} />
            <ConfirmSubmitButton
              triggerLabel={<Trash2 className="size-[18px]" />}
              triggerAriaLabel={common('remove')}
              triggerTitle={common('remove')}
              confirmLabel={common('confirm')}
              cancelLabel={common('cancel')}
              prompt={t('removeProviderPrompt', { name: provider.name })}
              pendingLabel={t('removingProvider')}
              className="items-center justify-end"
              triggerClassName="ui-button-ghost ui-icon-button text-red-600 dark:text-red-300"
              confirmClassName="inline-flex h-10 items-center rounded-md bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700"
              cancelClassName="ui-button-secondary h-10 px-4 text-sm"
              promptClassName="max-w-sm text-xs text-muted-foreground"
            />
          </form>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 sm:px-6 sm:pb-6">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{t('models')}</h3>
            <span className="text-xs tabular-nums text-muted-foreground">{provider.modelCount}</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
            <label className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
              <span className="sr-only">{t('searchModels')}</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('searchModels')}
                className="ui-input h-8 w-full pl-8 pr-2 text-xs"
              />
            </label>
            <form action={refreshAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="providerId" value={provider.id} />
              <SubmitButton
                error={refreshState.error}
                pendingLabel={t('refreshing')}
                savedLabel={t('refreshed')}
                ariaLabel={t('refreshModels')}
                title={t('refreshModels')}
                className="ui-button-secondary h-8 shrink-0 gap-1.5 px-2.5 text-xs"
              >
                <RefreshCw className="size-3.5" />
                <span className="hidden sm:inline">{t('refreshModels')}</span>
              </SubmitButton>
            </form>
          </div>
        </div>
        <ActionMessage state={refreshState} />
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {visibleModels.length > 0 ? (
            <div className="space-y-0.5">
              {visibleModels.map((model) => (
                <ModelTestRow key={model} slug={slug} providerId={provider.id} model={model} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {provider.models.length > 0 ? t('noMatchingModels') : t('noModelsCachedYet')}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function ProvidersPanel({
  slug,
  providers,
  piProviderPresets = [],
  embedded = false,
}: {
  slug: string;
  providers: ProviderRow[];
  piProviderPresets?: ProviderPreset[];
  embedded?: boolean;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const [providerQuery, setProviderQuery] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(providers[0]?.id ?? null);
  const visibleProviders = useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase();
    if (!query) return providers;
    return providers.filter((provider) => [provider.name, provider.format, ...provider.models]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [providerQuery, providers]);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? providers[0] ?? null;

  return (
    <div className={embedded ? 'flex h-full min-h-0' : 'flex min-h-0 flex-1 p-3 sm:p-4'}>
      <div className={`flex min-h-0 w-full flex-col overflow-hidden bg-background md:flex-row ${embedded ? '' : 'rounded-lg border border-border'}`}>
        <aside className="flex max-h-56 w-full shrink-0 flex-col border-b border-border md:max-h-none md:h-full md:w-[248px] md:border-b-0 md:border-r">
          <div className="flex shrink-0 items-center gap-1.5 px-2.5 pt-2.5">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">{common('search')} {t('modelProviders')}</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={providerQuery}
                onChange={(event) => setProviderQuery(event.target.value)}
                placeholder={common('search')}
                className="ui-input h-8 w-full rounded-[10px] pl-8 pr-2 text-xs"
              />
            </label>
            <AddProviderDialog slug={slug} piProviderPresets={piProviderPresets} iconOnly />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            {visibleProviders.length > 0 ? (
              <div className="space-y-1">
                {visibleProviders.map((provider) => {
                  const selected = provider.id === selectedProvider?.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      aria-label={provider.name}
                      aria-pressed={selected}
                      onClick={() => setSelectedProviderId(provider.id)}
                      className={`group flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2 text-left transition-colors ${selected ? 'bg-muted' : 'hover:bg-muted/70'}`}
                    >
                      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-[10px] font-semibold text-muted-foreground">
                        {provider.name.charAt(0).toUpperCase() || 'P'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm text-foreground ${selected ? 'font-medium' : ''}`}>{provider.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{provider.format}</span>
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{provider.modelCount}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-full min-h-24 items-center justify-center px-3 text-center text-xs text-muted-foreground">
                {t('noProvidersYet')}
              </div>
            )}
          </div>
          <div className="shrink-0 px-2.5 pb-2.5 text-[11px] text-muted-foreground">
            {providers.length} {t('providers')}
          </div>
        </aside>

        {selectedProvider ? (
          <ProviderDetail
            key={selectedProvider.id}
            slug={slug}
            provider={selectedProvider}
            piProviderPresets={piProviderPresets}
          />
        ) : (
          <div className="flex min-h-64 flex-1 flex-col items-center justify-center px-5 text-center">
            <Cpu className="mb-3 size-8 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">{t('noProvidersYet')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('noProvidersYetAddOneAboveThenRefreshItsModels')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
