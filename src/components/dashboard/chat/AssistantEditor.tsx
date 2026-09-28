'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, ChevronRight, Eye, Loader2, Pencil, Plus, RotateCcw, Sparkles, Store, Trash2 } from 'lucide-react';
import { Button } from '@/components/motion/button';
import { Input } from '@/components/motion/input';
import { FormCheckbox } from '@/components/ui/FormCheckbox';
import { FormSelect } from '@/components/ui/FormSelect';
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalClose } from '@/components/motion/center-morph-modal';
import { ModelPicker, type ModelProviderOption } from '@/components/dashboard/models/ModelPicker';
import { AssistantMarkdown } from '@/components/dashboard/ConversationMessage';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import { estimatePromptTokens } from '@/lib/prompt-tokens';
import { cn as cx } from '@/lib/utils';
import type { AssistantMarketTemplate, ChatAssistantItem } from './WorkspaceAssistantChat';

type ProviderOption = ModelProviderOption & { format: string };
type McpOption = { id: string; name: string; status: string; keywords?: string[] };
type AssistantCreateStep = 'basic' | 'instructions' | 'modelParameters' | 'tools';
type AssistantModelParameters = NonNullable<ChatAssistantItem['modelParameters']>;
type AssistantCustomParameter = NonNullable<AssistantModelParameters['customParameters']>[number];
const inputClassNames = { field: 'rounded-xl', input: 'text-sm' };
function defaultCustomParameterValue(type: AssistantCustomParameter['type']): AssistantCustomParameter['value'] {
  if (type === 'number') return 0;
  if (type === 'boolean') return false;
  return '';
}

function hasValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function AssistantEditor({
  assistant,
  deployments,
  marketTemplate,
  marketTemplates,
  onClose,
  onDelete,
  onSaved,
  onTemplateSelect,
  open,
  providers,
  slug,
  workspaceId,
}: {
  assistant: ChatAssistantItem | null;
  deployments: McpOption[];
  marketTemplate: AssistantMarketTemplate | null;
  marketTemplates: AssistantMarketTemplate[];
  onClose: () => void;
  onDelete: (assistantId: string) => Promise<void>;
  onSaved: (assistantId: string, created: boolean) => Promise<void>;
  onTemplateSelect: (template: AssistantMarketTemplate | null) => void;
  open: boolean;
  providers: ProviderOption[];
  slug: string;
  workspaceId: string;
}) {
  const t = useTranslations('console.chatAssistants');
  const common = useTranslations('common');
  const creating = !assistant;
  const [closing, setClosing] = useState(false);
  const [createStep, setCreateStep] = useState<AssistantCreateStep>('basic');
  const [name, setName] = useState(assistant?.name ?? marketTemplate?.name ?? '');
  const [description, setDescription] = useState(assistant?.description ?? '');
  const templateProvider = marketTemplate?.providerFormat
    ? providers.find((provider) => (
      provider.format === marketTemplate.providerFormat
      && (!marketTemplate.model || provider.models.includes(marketTemplate.model))
    ))
    : null;
  const initialProviderId = assistant?.modelProviderId ?? templateProvider?.id ?? providers[0]?.id ?? '';
  const [providerId, setProviderId] = useState(initialProviderId);
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? null;
  const [model, setModel] = useState(
    assistant?.model
    ?? (templateProvider ? marketTemplate?.model : null)
    ?? selectedProvider?.models[0]
    ?? '',
  );
  const initialModelParameters = assistant?.modelParameters ?? {};
  const [temperatureEnabled, setTemperatureEnabled] = useState(initialModelParameters.temperature !== undefined);
  const [temperature, setTemperature] = useState(initialModelParameters.temperature ?? 1);
  const [topPEnabled, setTopPEnabled] = useState(initialModelParameters.topP !== undefined);
  const [topP, setTopP] = useState(initialModelParameters.topP ?? 1);
  const [maxOutputTokensEnabled, setMaxOutputTokensEnabled] = useState(initialModelParameters.maxOutputTokens !== undefined);
  const [maxOutputTokens, setMaxOutputTokens] = useState(initialModelParameters.maxOutputTokens ?? 4096);
  const [customParameters, setCustomParameters] = useState<AssistantCustomParameter[]>(initialModelParameters.customParameters ?? []);
  const initialSystemPrompt = assistant?.systemPrompt ?? marketTemplate?.systemPrompt ?? '';
  const [systemPrompt, setSystemPrompt] = useState(initialSystemPrompt);
  const [showPromptPreview, setShowPromptPreview] = useState(Boolean(initialSystemPrompt.trim()));
  const [generatingPrompt, setGeneratingPrompt] = useState(false);
  const [promptRestore, setPromptRestore] = useState<{ previous: string; generated: string } | null>(null);
  const [showMarketTemplates, setShowMarketTemplates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createSteps: Array<{ id: AssistantCreateStep; label: string }> = [
    { id: 'basic', label: t('basic') },
    { id: 'instructions', label: t('systemPrompt') },
    { id: 'modelParameters', label: t('modelParameters') },
    { id: 'tools', label: t('mcpAccess') },
  ];
  const createStepIndex = createSteps.findIndex((step) => step.id === createStep);
  const lastCreateStep = createStepIndex === createSteps.length - 1;
  const basicComplete = Boolean(name.trim() && providerId && model);

  async function generateSystemPrompt() {
    if (!basicComplete || generatingPrompt) return;
    setGeneratingPrompt(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/chat/assistants/generate-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: name.trim(),
          description: description.trim() || null,
          systemPrompt: systemPrompt.trim() || null,
          modelProviderId: providerId,
          model,
        }),
      });
      const body = await response.json().catch(() => ({})) as { prompt?: string; error?: string };
      if (!response.ok || !body.prompt?.trim()) throw new Error(body.error || t('promptGenerationError'));
      const generated = body.prompt.trim();
      setPromptRestore({ previous: systemPrompt, generated });
      setSystemPrompt(generated);
      setShowPromptPreview(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('promptGenerationError'));
    } finally {
      setGeneratingPrompt(false);
    }
  }

  async function submit(formData: FormData) {
    setSaving(true);
    setError(null);
    try {
      const deploymentIds = formData.getAll('deploymentIds').map(String);
      const selectedCustomParameters = customParameters
        .filter((parameter) => parameter.name.trim())
        .map((parameter) => ({ ...parameter, name: parameter.name.trim() }));
      if (selectedCustomParameters.some((parameter) => (
        parameter.type === 'json' && !hasValidJson(String(parameter.value))
      ))) {
        throw new Error(t('invalidCustomParameter'));
      }
      const modelParameters: AssistantModelParameters = {
        ...(temperatureEnabled ? { temperature } : {}),
        ...(topPEnabled ? { topP } : {}),
        ...(maxOutputTokensEnabled ? { maxOutputTokens } : {}),
        ...(selectedCustomParameters.length ? { customParameters: selectedCustomParameters } : {}),
      };
      const response = await fetch(
        assistant ? `/api/v1/chat/assistants/${assistant.id}` : '/api/v1/chat/assistants',
        {
          method: assistant ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(!assistant ? { workspaceId } : {}),
            name: String(formData.get('name') ?? '').trim(),
            description: description.trim() || null,
            systemPrompt: systemPrompt.trim() || null,
            modelProviderId: providerId || null,
            model: model || null,
            modelParameters: Object.keys(modelParameters).length ? modelParameters : null,
            maxSteps: Number(formData.get('maxSteps') ?? AGENT_STEP_BOUNDS.default),
            deploymentIds,
            ...(!assistant && marketTemplate ? { marketTemplateReleaseId: marketTemplate.releaseId } : {}),
          }),
        },
      );
      const body = await response.json().catch(() => ({})) as {
        assistant?: { id?: string };
        id?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t('saveError'));
      const assistantId = body.assistant?.id ?? body.id ?? assistant?.id;
      if (!assistantId) throw new Error(t('saveError'));
      await onSaved(assistantId, !assistant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CenterMorphModal open={open && !closing} onOpenChange={(next) => { if (!next) setClosing(true); }}>
      <>
        
        <CenterMorphModalContent ariaLabel={assistant ? t('editAssistant') : t('newAssistant')} closeButtonLabel={common('close')} onExitComplete={onClose} className="z-[51] flex max-h-[calc(100dvh-4rem)] max-w-3xl flex-col gap-0 overflow-hidden">
          <header className="flex shrink-0 items-start gap-3 border-b border-border pl-5 pr-16 py-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">
                {assistant ? t('editAssistant') : t('newAssistant')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('boundaryDescription')}</p>
            </div>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(new FormData(event.currentTarget));
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <nav
                aria-label={t('configurationNavigation')}
                className="shrink-0 border-b border-border/60 bg-muted/20 sm:w-48 sm:border-b-0 sm:border-r"
              >
                <ol className="flex gap-1 overflow-x-auto p-2 sm:block sm:space-y-1 sm:p-3">
                  {createSteps.map((step, index) => {
                    const active = index === createStepIndex;
                    const done = index < createStepIndex;
                    return (
                      <li key={step.id} className="shrink-0 sm:w-full">
                        <Button type="button" aria-label={step.label} aria-current={active ? (creating ? 'step' : 'page') : undefined} disabled={creating && index > createStepIndex} onClick={() => {
                          if (!creating || done) setCreateStep(step.id);
                        }} variant="ghost" size="sm" className="flex min-w-max justify-start rounded-lg text-left items-center gap-2 sm:w-full">{creating ? (
                          <span className={cx(
                            'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium',
                            active ? 'bg-foreground text-background' : 'border border-border text-muted-foreground',
                          )}>
                            {index + 1}
                          </span>
                        ) : null}
                        <span>{step.label}</span></Button>
                      </li>
                    );
                  })}
                </ol>
              </nav>

              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <section
                  hidden={createStep !== 'basic'}
                  aria-labelledby={creating ? 'assistant-create-basic-title' : undefined}
                  className="mx-auto max-w-2xl space-y-5 px-5 py-6 sm:px-8"
                >
                  {creating ? (
                    <>
                      <div>
                        <h3 id="assistant-create-basic-title" className="text-base font-semibold text-foreground">{t('basic')}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">{t('boundaryDescription')}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/35 p-2">
                        <Button type="button" onClick={() => onTemplateSelect(null)} variant={"secondary"} size={"sm"} ><Plus className="size-3.5" />
                        {t('blankAssistant')}</Button>
                        <Button type="button" onClick={() => setShowMarketTemplates((current) => !current)} variant={"secondary"} size={"sm"} ><Store className="size-3.5" />
                        {marketTemplate ? t('marketTemplateSelected') : t('chooseFromMarket')}</Button>
                        {marketTemplate ? (
                          <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground" title={marketTemplate.summary ?? marketTemplate.name}>
                            {marketTemplate.name}
                          </span>
                        ) : null}
                      </div>
                      {showMarketTemplates ? (
                        marketTemplates.length ? (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {marketTemplates.map((template) => (
                              <Button key={template.releaseId} type="button" aria-pressed={marketTemplate?.releaseId === template.releaseId} onClick={() => onTemplateSelect(template)} variant={"ghost"} size={"sm"} className="min-w-0 text-left"><span className="block truncate text-sm font-semibold text-foreground">{template.name}</span>
                              <span className="mt-1 line-clamp-2 block min-h-10 text-xs leading-5 text-muted-foreground">
                                {template.summary ?? t('boundaryDescription')}
                              </span>
                              <span className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                                {template.model ? <span className="rounded bg-muted px-1.5 py-0.5">{template.model}</span> : null}
                                {template.tags.slice(0, 2).map((tag) => (
                                  <span key={tag} className="rounded bg-muted px-1.5 py-0.5">{tag}</span>
                                ))}
                              </span></Button>
                            ))}
                          </div>
                        ) : (
                          <p className="rounded-lg bg-muted/35 px-3 py-4 text-sm text-muted-foreground">{t('noMarketTemplates')}</p>
                        )
                      ) : null}
                    </>
                  ) : null}

                  <div className="block text-xs font-medium text-muted-foreground">
                    <Input name="name" required maxLength={100} autoFocus placeholder={t('namePlaceholder')} value={String(name)} label={t('name')} onChange={(value) => setName(value)} className="mt-1.5 w-full" classNames={inputClassNames} />
                  </div>

                  <label className="block text-xs font-medium text-muted-foreground">
                    {t('description')}
                    <textarea
                      name="description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      rows={2}
                      maxLength={500}
                      className="mt-1.5 min-h-24 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm font-normal leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder={t('descriptionPlaceholder')}
                    />
                  </label>

                  <div className="block text-xs font-medium text-muted-foreground">
                    <span>{t('model')}</span>
                    <ModelPicker
                      providers={providers}
                      value={providerId && model ? { providerId, model } : null}
                      onSelect={(selection) => {
                        setProviderId(selection.providerId);
                        setModel(selection.model);
                      }}
                      onConfigure={() => {
                        window.location.assign(`/app/${encodeURIComponent(slug)}/providers`);
                      }}
                      trigger={(
                        <Button type="button" aria-label={`${t('model')}: ${model || t('selectModel')}`} variant="outline" size="sm" className="mt-1.5 flex h-11 w-full justify-start rounded-xl items-center gap-2 text-left"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                          {selectedProvider?.name.charAt(0).toUpperCase() || 'M'}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{model || t('selectModel')}</span>
                        <span className="hidden max-w-36 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /></Button>
                      )}
                    />
                  </div>
                </section>

                <section
                  hidden={createStep !== 'instructions'}
                  aria-labelledby={creating ? 'assistant-create-instructions-title' : undefined}
                  className="mx-auto max-w-2xl space-y-5 px-5 py-6 sm:px-8"
                >
                  {creating ? (
                    <div>
                      <h3 id="assistant-create-instructions-title" className="text-base font-semibold text-foreground">{t('systemPrompt')}</h3>
                    </div>
                  ) : null}
                  <div className="block text-xs font-medium text-muted-foreground">
                    <div className="flex items-center justify-between gap-3">
                      <span>{t('systemPrompt')}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button type="button" onClick={() => setShowPromptPreview((current) => !current)} aria-label={showPromptPreview ? t('editSystemPrompt') : t('previewSystemPrompt')} title={showPromptPreview ? t('editSystemPrompt') : t('previewSystemPrompt')} variant={"ghost"} size={"icon"}>{showPromptPreview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}</Button>
                        {promptRestore?.generated === systemPrompt ? (
                          <Button type="button" onClick={() => {
                            setSystemPrompt(promptRestore.previous);
                            setPromptRestore(null);
                          }} aria-label={common('undo')} title={common('undo')} variant={"ghost"} size={"icon"}><RotateCcw className="size-3.5" /></Button>
                        ) : null}
                        <Button type="button" disabled={!basicComplete || generatingPrompt} onClick={() => void generateSystemPrompt()} variant={"secondary"} size={"sm"} className="gap-1.5">{generatingPrompt ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                        {systemPrompt.trim() ? t('improvePrompt') : t('generatePrompt')}</Button>
                      </div>
                    </div>
                    {showPromptPreview ? (
                      <div className="mt-1.5 min-h-64 overflow-auto rounded-xl border border-border bg-background p-3 text-sm leading-6 text-foreground">
                        {systemPrompt.trim() ? <AssistantMarkdown text={systemPrompt} /> : <p className="text-muted-foreground">{t('systemPromptPlaceholder')}</p>}
                      </div>
                    ) : (
                      <textarea
                        name="systemPrompt"
                        value={systemPrompt}
                        aria-label={t('systemPrompt')}
                        onChange={(event) => {
                          setSystemPrompt(event.target.value);
                          setPromptRestore(null);
                        }}
                        rows={10}
                        maxLength={20_000}
                        className="mt-1.5 min-h-64 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm font-normal leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder={t('systemPromptPlaceholder')}
                      />
                    )}
                    <p aria-live="polite" className="mt-1.5 text-right text-xs font-normal text-muted-foreground">
                      {t('estimatedTokens', { count: estimatePromptTokens(systemPrompt) })}
                    </p>
                  </div>
                </section>

                <section
                  hidden={createStep !== 'modelParameters'}
                  aria-labelledby={creating ? 'assistant-create-model-parameters-title' : undefined}
                  className="mx-auto max-w-2xl space-y-5 px-5 py-6 sm:px-8"
                >
                  {creating ? (
                    <h3 id="assistant-create-model-parameters-title" className="text-base font-semibold text-foreground">{t('modelParameters')}</h3>
                  ) : null}
                  <div className="divide-y divide-border border-y border-border">
                    <div className="flex min-h-14 flex-col items-start gap-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <FormCheckbox checked={temperatureEnabled} label={t('useCustomTemperature')} onCheckedChange={(checked) => setTemperatureEnabled(checked)} />
                      </div>
                      <Input classNames={inputClassNames} min={0} max={2} step={0.1} disabled={!temperatureEnabled} aria-label={t('temperature')} type="number" value={String(temperature)} onChange={(value) => {
                          if (Number.isFinite(Number.parseFloat(value))) {
                            setTemperature(Number.parseFloat(value));
                          }
                        }} className="w-24 shrink-0" />
                    </div>
                    <div className="flex min-h-14 flex-col items-start gap-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <FormCheckbox checked={topPEnabled} label={t('useCustomTopP')} onCheckedChange={(checked) => setTopPEnabled(checked)} />
                      </div>
                      <Input classNames={inputClassNames} min={0} max={1} step={0.05} disabled={!topPEnabled} aria-label={t('topP')} type="number" value={String(topP)} onChange={(value) => {
                          if (Number.isFinite(Number.parseFloat(value))) {
                            setTopP(Number.parseFloat(value));
                          }
                        }} className="w-24 shrink-0" />
                    </div>
                    <div className="flex min-h-14 flex-col items-start gap-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <FormCheckbox checked={maxOutputTokensEnabled} label={t('useCustomMaxOutputTokens')} onCheckedChange={(checked) => setMaxOutputTokensEnabled(checked)} />
                      </div>
                      <Input classNames={inputClassNames} min={1} max={1_000_000} step={1} disabled={!maxOutputTokensEnabled} aria-label={t('maxOutputTokens')} type="number" value={String(maxOutputTokens)} onChange={(value) => {
                          if (Number.isFinite(Number.parseFloat(value))) {
                            setMaxOutputTokens(Number.parseFloat(value));
                          }
                        }} className="w-28 shrink-0" />
                    </div>
                  </div>
                  <div className="border-b border-border pb-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-medium text-foreground">{t('customParameters')}</h4>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('customParametersHint')}</p>
                      </div>
                      <Button type="button" onClick={() => setCustomParameters((current) => [
                        ...current,
                        { name: '', type: 'string', value: '' },
                      ])} variant={"secondary"} size={"sm"} className="shrink-0 gap-1.5"><Plus className="size-3.5" />
                      {t('addCustomParameter')}</Button>
                    </div>
                    {customParameters.length ? (
                      <div className="mt-3 space-y-3">
                        {customParameters.map((parameter, index) => {
                          const valueLabel = t('customParameterValue', {
                            name: parameter.name.trim() || String(index + 1),
                          });
                          const updateParameter = (patch: Partial<AssistantCustomParameter>) => {
                            setCustomParameters((current) => current.map((currentParameter, currentIndex) => {
                              if (currentIndex !== index) return currentParameter;
                              if (patch.type && patch.type !== currentParameter.type) {
                                return {
                                  ...currentParameter,
                                  ...patch,
                                  value: defaultCustomParameterValue(patch.type),
                                };
                              }
                              return { ...currentParameter, ...patch };
                            }));
                          };
                          return (
                            <div key={index} className="border-t border-border pt-3">
                              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_2rem]">
                                <Input classNames={inputClassNames} aria-label={t('customParameterName')} placeholder="top_k" value={String(parameter.name)} onChange={(value) => updateParameter({ name: value })} className="w-full" />
                                <FormSelect label={t('customParameterType')} value={parameter.type} onValueChange={(value) => updateParameter({ type: value as AssistantCustomParameter['type'] })} options={['string', 'number', 'boolean', 'json'].map((value) => ({ value, label: value }))} />
                                {parameter.type === 'number' ? (
                                  <Input classNames={inputClassNames} aria-label={valueLabel} type="number" value={String(typeof parameter.value === 'number' ? parameter.value : 0)} onChange={(value) => updateParameter({ value: Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : 0 })} className="w-full" />
                                ) : parameter.type === 'boolean' ? (
                                  <FormSelect label={valueLabel} value={String(parameter.value)} onValueChange={(value) => updateParameter({ value: value === 'true' })} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} />
                                ) : parameter.type === 'json' ? (
                                  <span className="hidden sm:block" />
                                ) : (
                                  <Input classNames={inputClassNames} aria-label={valueLabel} value={String(parameter.value)} onChange={(value) => updateParameter({ value })} className="w-full" />
                                )}
                                <Button type="button" onClick={() => setCustomParameters((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={common('delete')} title={common('delete')} variant={"ghost"} size={"icon"}><Trash2 className="size-3.5" /></Button>
                              </div>
                              {parameter.type === 'json' ? (
                                <textarea
                                  value={String(parameter.value)}
                                  onChange={(event) => updateParameter({ value: event.target.value })}
                                  aria-label={valueLabel}
                                  rows={3}
                                  spellCheck={false}
                                  className="mt-1.5 min-h-36 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm font-normal leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
                                  placeholder={t('customParameterJsonPlaceholder')}
                                />
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </section>

                <section
                  hidden={createStep !== 'tools'}
                  aria-labelledby={creating ? 'assistant-create-tools-title' : undefined}
                  className="mx-auto max-w-2xl space-y-5 px-5 py-6 sm:px-8"
                >
                  {creating ? (
                    <div>
                      <h3 id="assistant-create-tools-title" className="text-base font-semibold text-foreground">{t('mcpAccess')}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{t('mcpDescription')}</p>
                    </div>
                  ) : null}

                  <div className="block max-w-44 text-xs font-medium text-muted-foreground">
                    <Input classNames={inputClassNames} name="maxSteps" min={AGENT_STEP_BOUNDS.min} max={AGENT_STEP_BOUNDS.max} type="number" defaultValue={String(assistant?.maxSteps ?? marketTemplate?.maxSteps ?? AGENT_STEP_BOUNDS.default)} label={t('maxToolSteps')} className="w-full" />
                  </div>

                  <fieldset>
                    <legend className={creating ? 'sr-only' : 'text-xs font-medium text-muted-foreground'}>{t('mcpAccess')}</legend>
                    {!creating ? <p className="mt-1 text-xs text-muted-foreground">{t('mcpDescription')}</p> : null}
                    {marketTemplate?.missingMcpNames?.length ? (
                      <p role="alert" className="mt-2 text-xs leading-5 text-muted-foreground text-muted-foreground">
                        {t('marketTemplateMissingMcp', { names: marketTemplate.missingMcpNames.join(', ') })}{' '}
                        <Link href={`/app/${encodeURIComponent(slug)}/market/mcp`} className="font-medium underline">
                          {t('browseMcpMarket')}
                        </Link>
                      </p>
                    ) : null}
                    <div className="mt-2 divide-y divide-border border-y border-border">
                      {deployments.length ? deployments.map((deployment) => (
                        <div key={deployment.id} className="flex min-h-10 items-center gap-3 py-2 text-sm">
                          <FormCheckbox name="deploymentIds" value={deployment.id} defaultChecked={assistant?.deploymentIds.includes(deployment.id) || marketTemplate?.deploymentIds.includes(deployment.id)} label={deployment.name} />
                          
                          <span className={cx(
                            'text-[11px]',
                            deployment.status === 'running' ? 'text-primary text-primary' : 'text-muted-foreground',
                          )}>{deployment.status}</span>
                        </div>
                      )) : <p className="py-4 text-sm text-muted-foreground">{t('noMcp')}</p>}
                    </div>
                  </fieldset>
                </section>

                {error ? <p role="alert" className="mx-auto max-w-2xl px-5 text-sm text-destructive sm:px-8">{error}</p> : null}
              </div>
            </div>
            <footer className={cx(
              'flex shrink-0 flex-wrap items-center gap-3 border-t border-border/60 px-5 py-3',
              creating ? 'justify-end' : 'justify-between',
            )}>
              {assistant ? (
                <div>
                  <Button type="button" onClick={() => void onDelete(assistant.id)} variant={"secondary"} size={"sm"}><Trash2 className="size-4" />
                  {common('delete')}</Button>
                </div>
              ) : null}
              <div className="flex gap-2">
                <CenterMorphModalClose><Button type="button" variant={"secondary"} size={"sm"}>{common('cancel')}</Button></CenterMorphModalClose>
                {creating && createStepIndex > 0 ? (
                  <Button type="button" onClick={() => setCreateStep(createSteps[createStepIndex - 1]!.id)} variant={"secondary"} size={"sm"} className="gap-2"><ChevronLeft className="size-4" />
                  {t('back')}</Button>
                ) : null}
                {creating && !lastCreateStep ? (
                  <Button type="button" disabled={createStep === 'basic' && !basicComplete} onClick={(event) => {
                    if (!event.currentTarget.form?.reportValidity()) return;
                    setCreateStep(createSteps[createStepIndex + 1]!.id);
                  }} variant={"primary"} size={"sm"} className="gap-2">{t('next')}
                  <ChevronRight className="size-4" /></Button>
                ) : null}
                {creating && lastCreateStep ? (
                  <Button type="submit" disabled={saving || !basicComplete} variant={"primary"} size={"sm"} className="gap-2"><Plus className="size-4" />
                  {saving ? t('saving') : t('createAssistant')}</Button>
                ) : null}
                {!creating ? (
                  <Button type="submit" disabled={saving} variant={"primary"} size={"sm"}>{saving ? t('saving') : common('save')}</Button>
                ) : null}
              </div>
            </footer>
          </form>
        </CenterMorphModalContent>
      </>
    </CenterMorphModal>
  );
}
