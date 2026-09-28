'use client';
import { AnimatedBadge } from '@/components/motion/animated-badge';
import { Button } from '@/components/motion/button/base';
import { Input } from '@/components/motion/input';
import { Tooltip } from '@/components/motion/tooltip';
import { FormSelect } from '@/components/ui/FormSelect';
import { CenterMorphModal, CenterMorphModalTrigger, CenterMorphModalClose, CenterMorphModalContent } from '@/components/motion/center-morph-modal';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useRef, useState, ReactElement, ReactNode } from 'react';

import { ArrowUpDown, AudioLines, Boxes, BrainCircuit, ChevronDown, ChevronRight, ChevronUp, Cpu, Eye, FlaskConical, Image as ImageIcon, KeyRound, Link2, Pencil, Plus, RefreshCw, Save, Search, Trash2, Type, Video, Wrench } from 'lucide-react';
import {
  addProviderModelAction,
  createProviderAction,
  deleteProviderModelAction,
  deleteProviderAction,
  testProviderModelAction,
  updateProviderModelAction,
  updateProviderAction,
  type ActionState,
} from '@/lib/agents/actions';
import {
  MODEL_CAPABILITIES,
  MODEL_INPUT_MODALITIES,
  MODEL_PRIMARY_TYPES,
  defaultProviderModel,
  type ModelCapability,
  type ModelInputModality,
  type ModelPrimaryType,
  type ProviderModelValues,
} from '@/lib/agents/model-catalog';
import { ConfirmSubmitButton } from '@/components/dashboard/ConfirmSubmitButton';
import { SubmitButton } from '@/components/dashboard/SubmitButton';
import { ProviderModelAutofill } from '@/components/dashboard/agents/ProviderModelAutofill';

export type ProviderRow = {
  id: string;
  name: string;
  format: string;
  baseUrl: string;
  modelCount: number;
  models: string[];
  modelRecords?: Array<Omit<ProviderModelRow, 'primaryType' | 'capabilities' | 'inputModalities'> & {
    primaryType: string;
    capabilities: string[];
    inputModalities: string[];
  }>;
  modelsFetchedAt: string | null;
};

export type ProviderModelRow = ProviderModelValues & { source: string };

type ProviderPreset = { format: string; name: string; baseUrl: string };

const customProviderPresets: ProviderPreset[] = [
  { format: 'openai', name: 'OpenAI-compatible', baseUrl: '' },
  { format: 'openai-responses', name: 'OpenAI Responses-compatible', baseUrl: '' },
  { format: 'anthropic', name: 'Anthropic-compatible', baseUrl: '' },
];

function providerEndpoint(provider: ProviderRow, presets: ProviderPreset[], fallback: string) {
  return provider.baseUrl || presets.find((preset) => preset.format === provider.format)?.baseUrl || fallback;
}

function ActionMessage({ state }: { state: ActionState }) {
  if (state.error) {
    return <p className="mt-2 text-sm text-destructive" role="alert">{state.error}</p>;
  }
  if (state.warning) {
    return <p className="mt-2 text-sm text-muted-foreground text-muted-foreground" role="alert">{state.warning}</p>;
  }
  return null;
}

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
  trigger: ReactElement;
  title: string;
  maxWidth?: 'max-w-xl' | 'max-w-2xl';
  children: ReactNode;
}) {
  const t = useTranslations('console.agents');

  return (
    <CenterMorphModal open={open} onOpenChange={onOpenChange}>
      <Tooltip content={title}><CenterMorphModalTrigger>{trigger}</CenterMorphModalTrigger></Tooltip>
      <>
        
        <CenterMorphModalContent ariaLabel={title} closeButtonLabel={t('close')} className={maxWidth}>
          <div className="flex items-center border-b border-border pl-5 pr-16 py-4">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
          </div>
          <div className="max-h-[calc(100vh-7rem)] overflow-y-auto">
            {children}
          </div>
        </CenterMorphModalContent>
      </>
    </CenterMorphModal>
  );
}

function ModelTypeIcon({ type }: { type: ModelPrimaryType }) {
  if (type === 'image') return <ImageIcon className="size-3.5" />;
  if (type === 'embedding') return <Boxes className="size-3.5" />;
  if (type === 'rerank') return <ArrowUpDown className="size-3.5" />;
  return <Type className="size-3.5" />;
}

function ModelOptionButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
      <Button type="button" aria-pressed={pressed} onClick={onClick} variant={pressed ? 'secondary' : 'ghost'} size="sm">
        {children}
      </Button>
  );
}

function ModelClassificationControls({
  primaryType,
  capabilities,
  inputModalities,
  onPrimaryTypeChange,
  onCapabilitiesChange,
  onInputModalitiesChange,
}: {
  primaryType: ModelPrimaryType;
  capabilities: ModelCapability[];
  inputModalities: ModelInputModality[];
  onPrimaryTypeChange: (value: ModelPrimaryType) => void;
  onCapabilitiesChange: (value: ModelCapability[]) => void;
  onInputModalitiesChange: (value: ModelInputModality[]) => void;
}) {
  const t = useTranslations('console.agents');
  const typeLabels: Record<ModelPrimaryType, string> = {
    text: t('modelTypeText'),
    image: t('modelTypeImage'),
    embedding: t('modelTypeEmbedding'),
    rerank: t('modelTypeRerank'),
  };
  const toggleCapability = (capability: ModelCapability) => onCapabilitiesChange(
    capabilities.includes(capability)
      ? capabilities.filter((value) => value !== capability)
      : [...capabilities, capability],
  );
  const toggleModality = (modality: ModelInputModality) => onInputModalitiesChange(
    inputModalities.includes(modality)
      ? inputModalities.filter((value) => value !== modality)
      : [...inputModalities, modality],
  );

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/20 p-3">
      <div role="group" aria-label={t('modelType')}>
        <p className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">{t('modelType')}</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(typeLabels) as ModelPrimaryType[]).map((type) => (
            <ModelOptionButton key={type} pressed={primaryType === type} onClick={() => onPrimaryTypeChange(type)}>
              <ModelTypeIcon type={type} />
              {typeLabels[type]}
            </ModelOptionButton>
          ))}
        </div>
      </div>
      <div role="group" aria-label={t('modelCapabilities')}>
        <p className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">{t('modelCapabilities')}</p>
        <div className="flex flex-wrap gap-2">
          <ModelOptionButton pressed={capabilities.includes('reasoning')} onClick={() => toggleCapability('reasoning')}>
            <BrainCircuit className="size-3.5" />
            {t('capabilityReasoning')}
          </ModelOptionButton>
          <ModelOptionButton pressed={capabilities.includes('function_calling')} onClick={() => toggleCapability('function_calling')}>
            <Wrench className="size-3.5" />
            {t('capabilityTools')}
          </ModelOptionButton>
        </div>
      </div>
      <div role="group" aria-label={t('inputModalities')}>
        <p className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">{t('inputModalities')}</p>
        <div className="flex flex-wrap gap-2">
          <ModelOptionButton pressed={inputModalities.includes('image')} onClick={() => toggleModality('image')}>
            <Eye className="size-3.5" />
            {t('modalityVision')}
          </ModelOptionButton>
          <ModelOptionButton pressed={inputModalities.includes('audio')} onClick={() => toggleModality('audio')}>
            <AudioLines className="size-3.5" />
            {t('modalityAudio')}
          </ModelOptionButton>
          <ModelOptionButton pressed={inputModalities.includes('video')} onClick={() => toggleModality('video')}>
            <Video className="size-3.5" />
            {t('modalityVideo')}
          </ModelOptionButton>
        </div>
      </div>
      {capabilities.map((capability) => <input key={capability} type="hidden" name="capabilities" value={capability} />)}
      {inputModalities.map((modality) => <input key={modality} type="hidden" name="inputModalities" value={modality} />)}
      <input type="hidden" name="primaryType" value={primaryType} />
    </div>
  );
}

function ModelLimits({
  model,
  onChange,
}: {
  model: ProviderModelValues;
  onChange: (values: Partial<Pick<ProviderModelValues, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens'>>) => void;
}) {
  const t = useTranslations('console.agents');
  const setValue = (field: 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens', value: string) => onChange({
    [field]: value ? Number(value) : null,
  });
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Input label={t('contextWindow')} leftIcon={<Cpu />} name="contextWindow" type="number" min="1" max="100000000" placeholder="128000" value={String(model.contextWindow ?? '')} onChange={(value) => setValue('contextWindow', value)} className="w-full" />
      <Input label={t('maxInputTokens')} leftIcon={<Cpu />} name="maxInputTokens" type="number" min="1" max="100000000" placeholder="128000" value={String(model.maxInputTokens ?? '')} onChange={(value) => setValue('maxInputTokens', value)} className="w-full" />
      <Input label={t('maxOutputTokens')} leftIcon={<Cpu />} name="maxOutputTokens" type="number" min="1" max="100000000" placeholder="65536" value={String(model.maxOutputTokens ?? '')} onChange={(value) => setValue('maxOutputTokens', value)} className="w-full" />
    </div>
  );
}

function ModelPrices({ model, onChange }: {
  model: ProviderModelValues;
  onChange: (values: Pick<ProviderModelValues, 'cost'>) => void;
}) {
  const t = useTranslations('console.agents');
  const numbers = new Intl.NumberFormat(useLocale());
  const fields = [
    ['input', 'catalogInputPrice'], ['output', 'catalogOutputPrice'],
    ['cacheRead', 'catalogCacheReadPrice'], ['cacheWrite', 'catalogCacheWritePrice'],
  ] as const;
  const base: NonNullable<ProviderModelValues['cost']> = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return (
    <fieldset className="space-y-3">
      <legend className="text-xs text-muted-foreground">{t('catalogPriceUnit')}</legend>
      <p className="text-xs text-muted-foreground">{t('catalogTierHint')}</p>
      {[{ rates: model.cost, label: t('catalogBasePrice'), index: -1 }, ...(model.cost?.tiers ?? []).map((rates, index) => ({ rates, label: t('catalogTierAbove', { tokens: numbers.format(rates.inputTokensAbove) }), index }))].map(({ rates, label, index }) => (
        <fieldset key={index} className="space-y-2">
          <legend className="text-xs font-medium">{label}</legend>
          {index >= 0 ? (
            <div className="flex items-end gap-2">
              <Input label={t('catalogTierThreshold')} type="number" min="0" step="1" required value={String(base.tiers![index].inputTokensAbove)} onChange={(value) => {
                onChange({ cost: { ...base, tiers: base.tiers!.map((tier, tierIndex) => tierIndex === index ? { ...tier, inputTokensAbove: Number(value) } : tier) } });
              }} className="min-w-0 flex-1" />
              <Button type="button" variant="secondary" size="icon" aria-label={t('catalogRemoveTier')} onClick={() => {
                const { tiers, ...rates } = base;
                const remaining = tiers!.filter((_, tierIndex) => tierIndex !== index);
                onChange({ cost: { ...rates, ...(remaining.length ? { tiers: remaining } : {}) } });
              }}><Trash2 aria-hidden="true" className="size-4" /></Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map(([field, translation]) => (
              <Input key={field} label={t(translation)} type="number" min="0" step="any" value={String(rates?.[field] ?? '')} onChange={(value) => {
                const price = value ? Number(value) : 0;
                onChange({ cost: index < 0 ? { ...base, [field]: price } : { ...base, tiers: base.tiers?.map((tier, tierIndex) => tierIndex === index ? { ...tier, [field]: price } : tier) } });
              }} className="w-full" />
            ))}
          </div>
        </fieldset>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => {
        const { tiers = [], ...rates } = base;
        const inputTokensAbove = Math.max(0, ...tiers.map((tier) => tier.inputTokensAbove)) + 1;
        onChange({ cost: { ...base, tiers: [...tiers, { ...rates, inputTokensAbove }] } });
      }}><Plus aria-hidden="true" className="size-4" />{t('catalogAddTier')}</Button>
    </fieldset>
  );
}

function ModelEditorFields({
  model,
  modelIdReadOnly = false,
  onModelIdChange,
  onNameChange,
  onGroupChange,
}: {
  model: ProviderModelValues;
  modelIdReadOnly?: boolean;
  onModelIdChange?: (value: string) => void;
  onNameChange: (value: string) => void;
  onGroupChange: (value: string) => void;
}) {
  const t = useTranslations('console.agents');
  return (
    <div className="grid gap-3">
      <div className="space-y-1.5"><Input label={t('modelId')} leftIcon={<Cpu />} name="modelId" required readOnly={modelIdReadOnly} placeholder="gpt-5.5" value={String(model.modelId)} onChange={(value) => onModelIdChange?.(value)} /><p className="text-xs text-muted-foreground">{!modelIdReadOnly ? t('modelIdBatchHint') : undefined}</p></div>
      <Input label={t('modelName')} leftIcon={<Pencil />} name="name" placeholder="GPT-5.5" value={String(model.name)} onChange={(value) => onNameChange(value)} className="w-full" />
      <Input label={t('modelGroup')} leftIcon={<Boxes />} name="group" placeholder="ChatGPT" value={String(model.group)} onChange={(value) => onGroupChange(value)} className="w-full" />
    </div>
  );
}

function providerFormatOptions(piProviderPresets: ProviderPreset[]) {
  return [...piProviderPresets, ...customProviderPresets].map((preset) => ({ value: preset.format, label: preset.name }));
}

function AddProviderDialog({
  slug,
  piProviderPresets,
  onCreated,
}: {
  slug: string;
  piProviderPresets: ProviderPreset[];
  onCreated: (providerId: string) => void;
}) {
  const initialPreset = piProviderPresets[0] ?? customProviderPresets[0];
  const presets = [...piProviderPresets, ...customProviderPresets];
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<number | undefined>();
  const processedProviderId = useRef<string | null>(null);
  const [format, setFormat] = useState(initialPreset.format);
  const [name, setName] = useState(initialPreset.name);
  const [baseUrl, setBaseUrl] = useState('');
  const selectedPreset = presets.find((preset) => preset.format === format);
  const isCustomProvider = !format.startsWith('pi:');
  const [state, formAction] = useActionState<ActionState, FormData>(createProviderAction, {});
  const [apiKey, setApiKey] = useState('');
  // Secret input is cleared after every action result; it must not survive a failed or successful submission.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setApiKey(''); }, [state]);
  useEffect(() => {
    if (!state.providerId || processedProviderId.current === state.providerId) return;
    processedProviderId.current = state.providerId;
    onCreated(state.providerId);
  }, [state.providerId, onCreated]);

  return (
    <ProviderDialog
      open={open && (!state.savedAt || state.savedAt === savedAtWhenOpened)}
      onOpenChange={(next) => {
        if (next) setSavedAtWhenOpened(state.savedAt);
        else setApiKey('');
        setOpen(next);
      }}
      title={t('addModelProvider')}
      trigger={(
        <Button variant="secondary" size="icon" type="button" aria-label={t('addProvider')}>
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      )}
    >
        <form action={formAction} className="grid gap-3 px-5 py-5 xl:grid-cols-2">
          <input type="hidden" name="workspace" value={slug} />
          <Input label={t('name')} leftIcon={<Cpu />} name="name" required value={String(name)} onChange={(value) => setName(value)} className="w-full" />
          <div className="space-y-1.5"><p className="text-sm font-medium">{t('format')}</p><FormSelect name="format" value={format} label={t('format')} options={[providerFormatOptions(piProviderPresets)].flat().filter((option) => option != null)} onValueChange={(value) => {
                const preset = presets.find((candidate) => candidate.format === value);
                setFormat(value);
                if (preset) {
                  setName(preset.name);
                  setBaseUrl('');
                }
              }} className="w-full" /></div>
              <div className="space-y-1.5"><Input label={t('baseUrl')} leftIcon={<Link2 />} name="baseUrl" required={isCustomProvider} placeholder={!isCustomProvider ? selectedPreset?.baseUrl : undefined} value={String(baseUrl)} onChange={(value) => setBaseUrl(value)} className="w-full" /><p className="text-xs text-muted-foreground">{!isCustomProvider && selectedPreset?.baseUrl
                  ? t('leaveBlankToUseDefaultEndpoint', { endpoint: selectedPreset.baseUrl })
                  : undefined}</p></div>
          <div className={isCustomProvider ? undefined : 'xl:col-span-2'}>
            <Input label={t('apiKey')} leftIcon={<KeyRound />} name="apiKey" type="password" value={apiKey} onChange={setApiKey} placeholder="API key or token" className="w-full" />
          </div>
          <div className="xl:col-span-2">
            <ActionMessage state={state} />
            <div className="mt-5 flex items-center justify-end gap-2">
              <CenterMorphModalClose>
                <Button size="sm" type="button" variant="secondary">{t('cancel')}</Button>
              </CenterMorphModalClose>
              <Tooltip content={t('addProvider')}>
                <SubmitButton error={state.error} pendingLabel="" savedLabel="" ariaLabel={t('addProvider')} variant="primary" size="icon">
                  <Plus aria-hidden="true" className="size-4" />
                </SubmitButton>
              </Tooltip>
            </div>
          </div>
        </form>
    </ProviderDialog>
  );
}

function AddModelDialog({ slug, providerId }: { slug: string; providerId: string }) {
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<number | undefined>();
  const [showMore, setShowMore] = useState(false);
  const [model, setModel] = useState<ProviderModelValues>(() => defaultProviderModel(''));
  const manualFields = useRef(new Set<keyof ProviderModelValues>());
  const updateModel = (values: Partial<ProviderModelValues>) => {
    for (const field of Object.keys(values) as Array<keyof ProviderModelValues>) manualFields.current.add(field);
    setModel((current) => ({ ...current, ...values }));
  };
  const [state, formAction] = useActionState<ActionState, FormData>(addProviderModelAction, {});

  function reset() {
    setModel(defaultProviderModel(''));
    manualFields.current.clear();
    setShowMore(false);
  }

  return (
    <ProviderDialog
      open={open && state.savedAt === savedAtWhenOpened}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          reset();
          setSavedAtWhenOpened(state.savedAt);
        }
        setOpen(nextOpen);
      }}
      title={t('addModel')}
      trigger={(
        <Button size="icon" variant="secondary" type="button" aria-label={t('addModel')}><Plus aria-hidden="true" className="size-4" /></Button>
      )}
    >
      <form action={formAction} className="px-5 py-5">
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="providerId" value={providerId} />
        <input type="hidden" name="cost" value={JSON.stringify(model.cost ?? null)} />
        <ModelEditorFields
          model={model}
          onModelIdChange={(modelId) => setModel((current) => ({
            ...defaultProviderModel(modelId),
            ...Object.fromEntries([...manualFields.current].map((field) => [field, current[field]])),
          }))}
          onNameChange={(name) => updateModel({ name })}
          onGroupChange={(group) => updateModel({ group })}
        />
        <ProviderModelAutofill slug={slug} providerId={providerId} modelId={model.modelId} name={model.name} open={open && state.savedAt === savedAtWhenOpened} setModel={setModel} manualFields={manualFields} />
        <Button type="button" onClick={() => setShowMore((value) => !value)} aria-expanded={showMore} variant="ghost" size="sm" className="mt-4">
          {t('moreSettings')}
          {showMore ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </Button>
        {showMore ? (
          <div className="mt-3 space-y-3">
            <ModelClassificationControls
              primaryType={model.primaryType}
              capabilities={model.capabilities}
              inputModalities={model.inputModalities}
              onPrimaryTypeChange={(primaryType) => updateModel({ primaryType })}
              onCapabilitiesChange={(capabilities) => updateModel({ capabilities })}
              onInputModalitiesChange={(inputModalities) => updateModel({ inputModalities })}
            />
            <ModelLimits model={model} onChange={updateModel} />
            <ModelPrices model={model} onChange={updateModel} />
          </div>
        ) : (
          <>
            <input type="hidden" name="primaryType" value={model.primaryType} />
            {model.capabilities.map((capability) => <input key={capability} type="hidden" name="capabilities" value={capability} />)}
            {model.inputModalities.map((modality) => <input key={modality} type="hidden" name="inputModalities" value={modality} />)}
            {model.contextWindow ? <input type="hidden" name="contextWindow" value={model.contextWindow} /> : null}
            {model.maxInputTokens ? <input type="hidden" name="maxInputTokens" value={model.maxInputTokens} /> : null}
            {model.maxOutputTokens ? <input type="hidden" name="maxOutputTokens" value={model.maxOutputTokens} /> : null}
          </>
        )}
        <ActionMessage state={state} />
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border pt-4">
          <CenterMorphModalClose><Button size="sm" type="button" variant="secondary">{t('cancel')}</Button></CenterMorphModalClose>
          <Tooltip content={t('addModel')}>
            <SubmitButton error={state.error} pendingLabel="" savedLabel="" ariaLabel={t('addModel')} variant="primary" size="icon">
              <Plus aria-hidden="true" className="size-4" />
            </SubmitButton>
          </Tooltip>
        </div>
      </form>
    </ProviderDialog>
  );
}

function EditModelDialog({
  slug,
  providerId,
  initialModel,
}: {
  slug: string;
  providerId: string;
  initialModel: ProviderModelRow;
}) {
  const t = useTranslations('console.agents');
  const [open, setOpen] = useState(false);
  const [savedAtWhenOpened, setSavedAtWhenOpened] = useState<number | undefined>();
  const [showMore, setShowMore] = useState(false);
  const [model, setModel] = useState<ProviderModelValues>(initialModel);
  const manualFields = useRef(new Set<keyof ProviderModelValues>());
  const updateModel = (values: Partial<ProviderModelValues>) => {
    for (const field of Object.keys(values) as Array<keyof ProviderModelValues>) manualFields.current.add(field);
    setModel((current) => ({ ...current, ...values }));
  };
  const [state, formAction] = useActionState<ActionState, FormData>(updateProviderModelAction, {});

  return (
    <ProviderDialog
      open={open && state.savedAt === savedAtWhenOpened}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setModel(initialModel);
          manualFields.current.clear();
          setShowMore(false);
          setSavedAtWhenOpened(state.savedAt);
        }
        setOpen(nextOpen);
      }}
      title={t('editModel')}
      trigger={(
        <Button size="icon" variant="ghost" type="button" aria-label={t('editModel')}><Pencil aria-hidden="true" className="size-4" /></Button>
      )}
    >
      <form action={formAction} className="px-5 py-5">
        <input type="hidden" name="workspace" value={slug} />
        <input type="hidden" name="providerId" value={providerId} />
        <input type="hidden" name="cost" value={JSON.stringify(model.cost ?? null)} />
        <ModelEditorFields
          model={model}
          modelIdReadOnly
          onNameChange={(name) => updateModel({ name })}
          onGroupChange={(group) => updateModel({ group })}
        />
        <ProviderModelAutofill slug={slug} providerId={providerId} modelId={model.modelId} name={model.name} open={open && state.savedAt === savedAtWhenOpened} setModel={setModel} manualFields={manualFields} />
        <Button type="button" onClick={() => setShowMore((value) => !value)} aria-expanded={showMore} variant="ghost" size="sm" className="mt-4">
          {t('moreSettings')}
          {showMore ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </Button>
        {showMore ? (
          <div className="mt-3 space-y-3">
            <ModelClassificationControls
              primaryType={model.primaryType}
              capabilities={model.capabilities}
              inputModalities={model.inputModalities}
              onPrimaryTypeChange={(primaryType) => updateModel({ primaryType })}
              onCapabilitiesChange={(capabilities) => updateModel({ capabilities })}
              onInputModalitiesChange={(inputModalities) => updateModel({ inputModalities })}
            />
            <ModelLimits model={model} onChange={updateModel} />
            <ModelPrices model={model} onChange={updateModel} />
          </div>
        ) : (
          <>
            <input type="hidden" name="primaryType" value={model.primaryType} />
            {model.capabilities.map((capability) => <input key={capability} type="hidden" name="capabilities" value={capability} />)}
            {model.inputModalities.map((modality) => <input key={modality} type="hidden" name="inputModalities" value={modality} />)}
            {model.contextWindow ? <input type="hidden" name="contextWindow" value={model.contextWindow} /> : null}
            {model.maxInputTokens ? <input type="hidden" name="maxInputTokens" value={model.maxInputTokens} /> : null}
            {model.maxOutputTokens ? <input type="hidden" name="maxOutputTokens" value={model.maxOutputTokens} /> : null}
          </>
        )}
        <ActionMessage state={state} />
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border pt-4">
          <CenterMorphModalClose><Button size="sm" type="button" variant="secondary">{t('cancel')}</Button></CenterMorphModalClose>
          <Tooltip content={t('saveChanges')}>
            <SubmitButton error={state.error} pendingLabel="" savedLabel="" ariaLabel={t('saveChanges')} variant="primary" size="icon">
              <Save aria-hidden="true" className="size-4" />
            </SubmitButton>
          </Tooltip>
        </div>
      </form>
    </ProviderDialog>
  );
}

function DeleteModelForm({ slug, providerId, modelId }: { slug: string; providerId: string; modelId: string }) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const [state, action] = useActionState<ActionState, FormData>(deleteProviderModelAction, {});
  return (
    <form action={action} className="contents">
      <input type="hidden" name="workspace" value={slug} />
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="modelId" value={modelId} />
      <ConfirmSubmitButton
        triggerLabel={<Trash2 className="size-3.5" />}
        triggerAriaLabel={t('removeModel')}
        confirmLabel={common('confirm')}
        cancelLabel={common('cancel')}
        prompt={t('removeModelPrompt', { model: modelId })}
        pendingLabel={t('removingModel')}
        triggerVariant="ghost" triggerSize="icon"
        
        
        promptClassName="max-w-52 text-xs text-muted-foreground"
      />
      {state.error ? <span role="alert" className="text-xs text-destructive">{state.error}</span> : null}
    </form>
  );
}

function ModelTestRow({ slug, providerId, model, numbers, prices }: { slug: string; providerId: string; model: ProviderModelRow; numbers: Intl.NumberFormat; prices: Intl.NumberFormat }) {
  const t = useTranslations('console.agents');
  const [state, testAction] = useActionState<ActionState, FormData>(testProviderModelAction, {});
  const typeLabel = {
    text: t('modelTypeText'),
    image: t('modelTypeImage'),
    embedding: t('modelTypeEmbedding'),
    rerank: t('modelTypeRerank'),
  }[model.primaryType];

  return (
    <article aria-label={model.name} className="rounded-md px-2.5 py-2 transition-colors hover:bg-muted/60">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground">
            {model.name.charAt(0).toUpperCase() || 'M'}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-sm text-foreground">{model.name}</span>
              <Tooltip content={typeLabel}>
                <span tabIndex={0} aria-label={typeLabel} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <ModelTypeIcon type={model.primaryType} />
                </span>
              </Tooltip>
              {model.capabilities.includes('reasoning') ? <AnimatedBadge status="neutral">{t('capabilityReasoning')}</AnimatedBadge> : null}
              {model.capabilities.includes('function_calling') ? <AnimatedBadge status="neutral">{t('capabilityTools')}</AnimatedBadge> : null}
              {model.inputModalities.includes('image') ? <AnimatedBadge status="neutral">{t('modalityVision')}</AnimatedBadge> : null}
            </div>
            {model.name !== model.modelId ? <p className="truncate text-[11px] text-muted-foreground">{model.modelId}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {model.primaryType === 'text' ? (
            <form action={testAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="providerId" value={providerId} />
              <input type="hidden" name="model" value={model.modelId} />
              <Tooltip content={t('testModel')}>
              <SubmitButton
                error={state.error}
                pendingLabel=""
                savedLabel=""
                ariaLabel={t('testModel')}
                variant="ghost" size="icon"
                icon={<FlaskConical className="size-3.5" />}
              >
                {null}
              </SubmitButton>
              </Tooltip>
            </form>
          ) : null}
          <EditModelDialog slug={slug} providerId={providerId} initialModel={model} />
          <DeleteModelForm slug={slug} providerId={providerId} modelId={model.modelId} />
        </div>
      </div>
      {model.contextWindow !== null || model.maxInputTokens !== null || model.maxOutputTokens !== null ? (
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {([
            ['contextWindow', model.contextWindow],
            ['maxInputTokens', model.maxInputTokens],
            ['maxOutputTokens', model.maxOutputTokens],
          ] as const).map(([label, value]) => value !== null ? <div key={label} className="flex gap-1"><dt>{t(label)}:</dt><dd className="tabular-nums text-foreground">{numbers.format(value)}</dd></div> : null)}
        </dl>
      ) : null}
      {model.cost ? (
        <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          <p>{t('catalogPriceUnit')}</p>
          {[{ label: t('catalogBasePrice'), rates: model.cost }, ...(model.cost.tiers ?? []).map((tier) => ({ label: t('catalogTierAbove', { tokens: numbers.format(tier.inputTokensAbove) }), rates: tier }))].map(({ label, rates }) => (
            <dl key={label} className="flex flex-wrap gap-x-4 gap-y-1">
              {model.cost?.tiers?.length ? <div className="font-medium">{label}</div> : null}
              {([
                ['catalogInputPrice', rates.input], ['catalogOutputPrice', rates.output],
                ['catalogCacheReadPrice', rates.cacheRead], ['catalogCacheWritePrice', rates.cacheWrite],
              ] as const).map(([field, price]) => <div key={field} className="flex gap-1"><dt>{t(field)}:</dt><dd className="tabular-nums text-foreground">{prices.format(price)}</dd></div>)}
            </dl>
          ))}
        </div>
      ) : null}
      {state.error ? (
        <ActionMessage state={state} />
      ) : state.savedAt ? (
        <p className="mt-2 text-sm text-muted-foreground text-muted-foreground" role="status">{t('modelAvailable')}</p>
      ) : null}
    </article>
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
  const [apiKey, setApiKey] = useState('');
  // Secret input is cleared after every action result; it must not survive a failed or successful submission.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setApiKey(''); }, [updateState]);

  return (
    <ProviderDialog
      open={open}
      onOpenChange={(next) => { if (!next) setApiKey(''); setOpen(next); }}
      title={t('editProvider')}
      maxWidth="max-w-2xl"
      trigger={(
        <Button size="icon" variant="ghost" type="button" aria-label={t('editProvider')}>
          <Pencil aria-hidden="true" className="size-4" />
        </Button>
      )}
    >
        <form action={updateAction} className="grid gap-3 px-5 py-5 xl:grid-cols-2">
          <input type="hidden" name="workspace" value={slug} />
          <input type="hidden" name="providerId" value={provider.id} />
          <Input label={t('name')} leftIcon={<Cpu />} name="name" required defaultValue={String(provider.name)} className="w-full" />
          <div className="space-y-1.5"><p className="text-sm font-medium">{t('format')}</p><FormSelect name="format" value={format} label={t('format')} options={[providerFormatOptions(piProviderPresets)].flat().filter((option) => option != null)} onValueChange={(value) => {
              setFormat(value);
              setBaseUrl('');
            }} className="w-full" /></div>
          <div className="space-y-1.5"><Input label={t('baseUrl')} leftIcon={<Link2 />} name="baseUrl" required={isCustomProvider} placeholder={!isCustomProvider ? selectedPreset?.baseUrl : undefined} value={String(baseUrl)} onChange={(value) => setBaseUrl(value)} className="w-full" /><p className="text-xs text-muted-foreground">{!isCustomProvider && selectedPreset?.baseUrl
              ? t('leaveBlankToUseDefaultEndpoint', { endpoint: selectedPreset.baseUrl })
              : undefined}</p></div>
          <div className={isCustomProvider ? undefined : 'xl:col-span-2'}>
            <Input label={t('apiKey')} leftIcon={<KeyRound />} name="apiKey" type="password" value={apiKey} onChange={setApiKey} placeholder={t('leaveBlankToKeepCurrentKey')} className="w-full" />
          </div>
          <div className="xl:col-span-2">
            <ActionMessage state={updateState} />
            <div className="mt-5 flex items-center justify-end gap-2">
              <CenterMorphModalClose>
                <Button size="sm" type="button" variant="secondary">{t('cancel')}</Button>
              </CenterMorphModalClose>
              <Tooltip content={t('saveChanges')}>
                <SubmitButton error={updateState.error} pendingLabel="" savedLabel="" ariaLabel={t('saveChanges')} variant="primary" size="icon">
                  <Save aria-hidden="true" className="size-4" />
                </SubmitButton>
              </Tooltip>
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
  refreshState,
  refreshing,
  onRefresh,
}: {
  slug: string;
  provider: ProviderRow;
  piProviderPresets: ProviderPreset[];
  refreshState: ActionState;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations('console.agents');
  const locale = useLocale();
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const prices = useMemo(() => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 8 }), [locale]);
  const common = useTranslations('common');
  const [modelQuery, setModelQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ModelPrimaryType>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const endpoint = providerEndpoint(provider, piProviderPresets, t('builtInConnection'));
  const modelRecords = useMemo<ProviderModelRow[]>(() => {
    return provider.models.map((modelId) => {
      const defaults = defaultProviderModel(modelId);
      const stored = provider.modelRecords?.find((record) => record.modelId === modelId);
      if (!stored) return { ...defaults, source: 'remote' };
      return {
        ...stored,
        primaryType: MODEL_PRIMARY_TYPES.includes(stored.primaryType as ModelPrimaryType)
          ? stored.primaryType as ModelPrimaryType
          : defaults.primaryType,
        capabilities: stored.capabilities.filter((value): value is ModelCapability => MODEL_CAPABILITIES.includes(value as ModelCapability)),
        inputModalities: stored.inputModalities.filter((value): value is ModelInputModality => MODEL_INPUT_MODALITIES.includes(value as ModelInputModality)),
      };
    });
  }, [provider.modelRecords, provider.models]);
  const searchedModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return query
      ? modelRecords.filter((model) => [
          model.modelId,
          model.name,
          model.group,
          ...model.capabilities,
          ...model.inputModalities,
        ].some((value) => value.toLocaleLowerCase().includes(query)))
      : modelRecords;
  }, [modelQuery, modelRecords]);
  const typeCounts = useMemo(() => Object.fromEntries(
    (['text', 'image', 'embedding', 'rerank'] as ModelPrimaryType[])
      .map((type) => [type, searchedModels.filter((model) => model.primaryType === type).length]),
  ) as Record<ModelPrimaryType, number>, [searchedModels]);
  const visibleModels = useMemo(() => typeFilter === 'all'
    ? searchedModels
    : searchedModels.filter((model) => model.primaryType === typeFilter), [searchedModels, typeFilter]);
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ProviderModelRow[]>();
    for (const model of visibleModels) {
      const group = model.group.trim();
      groups.set(group, [...(groups.get(group) ?? []), model]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [visibleModels]);
  const allGroupsExpanded = modelGroups.every(([group]) => !collapsedGroups.has(group));

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold text-muted-foreground">
            {provider.name.charAt(0).toUpperCase() || 'P'}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold text-foreground">{provider.name}</h2>
              <AnimatedBadge status="neutral">
                {provider.format}
              </AnimatedBadge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{endpoint}</p>
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
              confirmLabel={common('confirm')}
              cancelLabel={common('cancel')}
              prompt={t('removeProviderPrompt', { name: provider.name })}
              pendingLabel={t('removingProvider')}
              className="items-center justify-end"
              triggerVariant="ghost" triggerSize="icon"
              
              
              promptClassName="max-w-sm text-xs text-muted-foreground"
            />
          </form>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 sm:px-6 sm:pb-6">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{t('models')}</h3>
            <span className="text-xs tabular-nums text-muted-foreground">{provider.modelCount}</span>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1 sm:justify-end">
            <div className="min-w-0 flex-1 sm:max-w-64">
              <Input leftIcon={<Search />} aria-label={t('searchModels')} placeholder={t('searchModels')} value={modelQuery} onChange={setModelQuery} className="w-full" />
            </div>
            <AddModelDialog slug={slug} providerId={provider.id} />
            <Tooltip content={t('refreshModels')}>
              <Button type="button" variant="secondary" size="icon" disabled={refreshing} aria-busy={refreshing || undefined} aria-label={t('refreshModels')} onClick={onRefresh}>
                <RefreshCw aria-hidden="true" className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border pb-2" role="tablist" aria-label={t('filterModels')}>
          <Button type="button" role="tab" aria-selected={typeFilter === 'all'} onClick={() => setTypeFilter('all')} variant={typeFilter === 'all' ? 'secondary' : 'ghost'} size={"sm"}>
            {t('allModels')}
            <span className="tabular-nums text-[10px] text-muted-foreground">{searchedModels.length}</span>
          </Button>
          {(['text', 'image', 'embedding', 'rerank'] as ModelPrimaryType[]).map((type) => {
            const label = type === 'text'
              ? t('modelTypeText')
              : type === 'image'
                ? t('modelTypeImage')
                : type === 'embedding'
                  ? t('modelTypeEmbedding')
                  : t('modelTypeRerank');
            return (
              <Button key={type} type="button" role="tab" aria-selected={typeFilter === type} onClick={() => setTypeFilter(type)} variant={typeFilter === type ? 'secondary' : 'ghost'} size="sm">
                <ModelTypeIcon type={type} />
                {label}
                <span className="tabular-nums text-[10px] text-muted-foreground">{typeCounts[type]}</span>
              </Button>
            );
          })}
          {modelGroups.length ? (
            <Tooltip content={allGroupsExpanded ? t('collapseAllGroups') : t('expandAllGroups')} wrapperClassName="ml-auto shrink-0">
            <Button type="button" onClick={() => setCollapsedGroups(allGroupsExpanded
                ? new Set(modelGroups.map(([group]) => group))
                : new Set())} aria-label={allGroupsExpanded ? t('collapseAllGroups') : t('expandAllGroups')} variant="ghost" size="icon">
              {allGroupsExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </Button>
            </Tooltip>
          ) : null}
        </div>
        {refreshing ? <p role="status" className="mt-2 text-sm text-muted-foreground">{t('modelsFetching')}</p>
          : refreshState.savedAt ? <p role="status" className="mt-2 text-sm text-muted-foreground">{t('modelsFetchComplete')}</p> : null}
        <ActionMessage state={refreshState.error ? { ...refreshState, error: `${t('modelsFetchFailedSaved')} ${refreshState.error}` } : refreshState} />
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {modelGroups.length > 0 ? (
            <div className="space-y-1 py-1">
              {modelGroups.map(([group, models]) => {
                const expanded = Boolean(modelQuery.trim()) || !collapsedGroups.has(group);
                return (
                  <section key={group || '__ungrouped'} className="overflow-hidden rounded-md border border-border">
                    <Button type="button" aria-expanded={expanded} onClick={() => setCollapsedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group)) next.delete(group);
                        else next.add(group);
                        return next;
                      })} variant="ghost" size="sm" className="w-full justify-start rounded-none px-3 text-left">
                      <ChevronRight className={`size-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                      <span className="min-w-0 flex-1 truncate">{group || t('ungroupedModels')}</span>
                      <span className="tabular-nums text-[10px] text-muted-foreground">{models.length}</span>
                    </Button>
                    {expanded ? (
                      <div className="divide-y divide-border/70">
                        {models.map((model) => (
                          <ModelTestRow key={model.modelId} slug={slug} providerId={provider.id} model={model} numbers={numbers} prices={prices} />
                        ))}
                      </div>
                    ) : null}
                  </section>
                );
              })}
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
  const router = useRouter();
  const [providerQuery, setProviderQuery] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(providers[0]?.id ?? null);
  const [refreshes, setRefreshes] = useState<Record<string, { pending: boolean; state: ActionState }>>({});

  async function refreshProvider(providerId: string) {
    setRefreshes((current) => ({ ...current, [providerId]: { pending: true, state: {} } }));
    let state: ActionState;
    try {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(slug)}/providers/${encodeURIComponent(providerId)}/models`, { method: 'POST' });
      state = await response.json() as ActionState;
      if (!response.ok && !state.error) state = { error: t('modelsFetchRequestFailed') };
      if (state.savedAt) router.refresh();
    } catch {
      state = { error: t('modelsFetchRequestFailed') };
    }
    setRefreshes((current) => ({ ...current, [providerId]: { pending: false, state } }));
  }

  function handleCreated(providerId: string) {
    setSelectedProviderId(providerId);
    setProviderQuery('');
    void refreshProvider(providerId);
  }
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
        <aside aria-label={t('modelProviders')} className="flex max-h-64 w-full shrink-0 flex-col border-b border-border bg-muted/20 md:max-h-none md:h-full md:w-64 md:border-b-0 md:border-r">
          <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-3">
            <h2 className="min-w-0 truncate text-sm font-semibold">{t('modelProviders')}</h2>
            <AddProviderDialog slug={slug} piProviderPresets={piProviderPresets} onCreated={handleCreated} />
          </div>
          <div className="px-3 pb-2">
            <Input leftIcon={<Search />} aria-label={`${common('search')} ${t('modelProviders')}`} placeholder={common('search')} value={providerQuery} onChange={setProviderQuery} className="w-full" />
          </div>
          <nav aria-label={t('modelProviders')} className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
            {visibleProviders.length > 0 ? (
              <div className="space-y-1">
                {visibleProviders.map((provider) => {
                  const selected = provider.id === selectedProvider?.id;
                  return (
                    <Button key={provider.id} type="button" aria-label={provider.name} aria-pressed={selected} aria-busy={refreshes[provider.id]?.pending || undefined} onClick={() => setSelectedProviderId(provider.id)} variant={selected ? 'secondary' : 'ghost'} className="h-auto min-h-14 w-full justify-start gap-3 rounded-lg px-2 py-2 text-left">
                      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-[10px] font-semibold text-muted-foreground">
                        {provider.name.charAt(0).toUpperCase() || 'P'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm text-foreground ${selected ? 'font-medium' : ''}`}>{provider.name}</span>
                        <span className={`block truncate text-[11px] ${refreshes[provider.id]?.state.error ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {refreshes[provider.id]?.pending ? t('modelsFetching') : refreshes[provider.id]?.state.error ? t('modelsFetchFailedLabel') : provider.format}
                        </span>
                      </span>
                      {refreshes[provider.id]?.pending ? <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        : <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{provider.modelCount}</span>}
                    </Button>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-full min-h-24 items-center justify-center px-3 text-center text-xs text-muted-foreground">
                {t('noProvidersYet')}
              </div>
            )}
          </nav>
          <div className="shrink-0 border-t border-border px-3 py-3 text-[11px] text-muted-foreground">
            {providers.length} {t('providers')}
          </div>
        </aside>

        {selectedProvider ? (
          <ProviderDetail
            key={selectedProvider.id}
            slug={slug}
            provider={selectedProvider}
            piProviderPresets={piProviderPresets}
            refreshState={refreshes[selectedProvider.id]?.state ?? {}}
            refreshing={refreshes[selectedProvider.id]?.pending ?? false}
            onRefresh={() => { void refreshProvider(selectedProvider.id); }}
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
