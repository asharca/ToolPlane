'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ContextMenu, Popover } from 'radix-ui';
import { SearchInput, SidebarActionRail } from '@asharca/ui';
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Cpu,
  Eye,
  Folder,
  FolderPlus,
  GitBranch,
  GripVertical,
  ListFilter,
  Loader2,
  MessageSquare,
  MoveRight,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Store,
  Trash2,
  X,
} from 'lucide-react';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import { AssistantMarkdown } from '@/components/dashboard/ConversationMessage';
import {
  ChatBranchPanel,
  type ChatBranchState,
} from '@/components/dashboard/chat/ChatBranchFlow';
import {
  ModelPicker,
  type ModelProviderOption,
  type ModelSelection,
} from '@/components/dashboard/models/ModelPicker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';
import { SidebarEntityActionsMenu } from '@/components/dashboard/SidebarEntityActionsMenu';
import { SidebarGroupDialog } from '@/components/dashboard/SidebarGroupDialog';
import { AGENT_STEP_BOUNDS } from '@/lib/agents/constants';
import { estimatePromptTokens } from '@/lib/prompt-tokens';
import {
  usePersistentBoolean,
  usePersistentBooleanRecord,
} from '@/lib/use-persistent-boolean';
import {
  assistantChatExpandedCookieName,
  assistantChatGroupPreferencesCookieName,
  assistantChatSidebarCookieName,
} from '@/lib/sidebar-preferences';
import {
  createSidebarGroupId,
  EMPTY_SIDEBAR_GROUP_PREFERENCES,
  type SidebarGroupPreferences,
} from '@/lib/sidebar-groups';
import { usePersistentSidebarGroups } from '@/lib/use-persistent-sidebar-groups';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

type ProviderOption = ModelProviderOption & { format: string };
type McpOption = { id: string; name: string; status: string; keywords?: string[] };
type AssistantCreateStep = 'basic' | 'instructions' | 'modelParameters' | 'tools';
type AssistantModelParameters = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  customParameters?: AssistantCustomParameter[];
};
type AssistantCustomParameter = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  value: string | number | boolean;
};

export type AssistantMarketTemplate = {
  releaseId: string;
  name: string;
  summary: string | null;
  tags: string[];
  systemPrompt: string | null;
  maxSteps: number;
  providerFormat: string | null;
  model: string | null;
  deploymentIds: string[];
  missingMcpNames?: string[];
};

export type ChatAssistantItem = {
  id: string;
  name: string;
  description?: string | null;
  pinned: boolean;
  systemPrompt: string | null;
  modelProviderId: string | null;
  model: string | null;
  modelParameters?: AssistantModelParameters | null;
  maxSteps: number;
  providerName: string | null;
  contextWindow?: number | null;
  contextWindowEstimated?: boolean;
  deploymentIds: string[];
  webSearchAvailable?: boolean;
  threads: Array<{
    id: string;
    title: string | null;
    createdAt: string;
    lastMessageAt: string | null;
  }>;
};

const EMPTY_EXPANDED_ASSISTANTS: Record<string, boolean> = {};
const UNGROUPED_SIDEBAR_GROUP_ID = '__ungrouped__';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function chatHref(slug: string, assistantId: string, threadId?: string) {
  const query = new URLSearchParams({ assistant: assistantId });
  if (threadId) query.set('thread', threadId);
  return `/app/${encodeURIComponent(slug)}/chat?${query}`;
}

export { estimatePromptTokens } from '@/lib/prompt-tokens';

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

function AssistantEditor({
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
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPortal>
        <DialogOverlay className="!bg-black/40" />
        <DialogContent className="!z-[51] !flex !h-[min(600px,calc(100vh-2rem))] !max-w-3xl !flex-col !gap-0 !overflow-hidden !rounded-xl !border-border !p-0">
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <DialogTitle className="!text-base !tracking-normal">
                {assistant ? t('editAssistant') : t('newAssistant')}
              </DialogTitle>
              <DialogDescription className="mt-1 !text-xs">{t('boundaryDescription')}</DialogDescription>
            </div>
            <button type="button" onClick={onClose} aria-label={common('close')} className="ui-button-ghost ui-icon-button -mr-2 -mt-2 shrink-0">
              <X className="size-4" />
            </button>
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
                        <button
                          type="button"
                          aria-label={step.label}
                          aria-current={active ? (creating ? 'step' : 'page') : undefined}
                          disabled={creating && index > createStepIndex}
                          onClick={() => {
                            if (!creating || done) setCreateStep(step.id);
                          }}
                          className={cx(
                            'flex h-10 min-w-max items-center gap-2 rounded-md px-3 text-sm transition-colors sm:w-full',
                            active ? 'bg-background font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                            'disabled:cursor-default disabled:opacity-55',
                          )}
                        >
                          {creating ? (
                            <span className={cx(
                              'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium',
                              active ? 'bg-foreground text-background' : 'border border-border text-muted-foreground',
                            )}>
                              {index + 1}
                            </span>
                          ) : null}
                          <span>{step.label}</span>
                        </button>
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
                        <button
                          type="button"
                          onClick={() => onTemplateSelect(null)}
                          className={cx('ui-button-secondary h-8 px-3 text-xs', !marketTemplate && 'bg-background text-foreground')}
                        >
                          <Plus className="size-3.5" />
                          {t('blankAssistant')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowMarketTemplates((current) => !current)}
                          className={cx('ui-button-secondary h-8 px-3 text-xs', marketTemplate && 'bg-background text-foreground')}
                        >
                          <Store className="size-3.5" />
                          {marketTemplate ? t('marketTemplateSelected') : t('chooseFromMarket')}
                        </button>
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
                              <button
                                key={template.releaseId}
                                type="button"
                                aria-pressed={marketTemplate?.releaseId === template.releaseId}
                                onClick={() => onTemplateSelect(template)}
                                className={cx(
                                  'min-w-0 rounded-lg border p-3 text-left transition-colors hover:bg-muted/40',
                                  marketTemplate?.releaseId === template.releaseId
                                    ? 'border-foreground/30 bg-muted/40'
                                    : 'border-border bg-card',
                                )}
                              >
                                <span className="block truncate text-sm font-semibold text-foreground">{template.name}</span>
                                <span className="mt-1 line-clamp-2 block min-h-10 text-xs leading-5 text-muted-foreground">
                                  {template.summary ?? t('boundaryDescription')}
                                </span>
                                <span className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                                  {template.model ? <span className="rounded bg-muted px-1.5 py-0.5">{template.model}</span> : null}
                                  {template.tags.slice(0, 2).map((tag) => (
                                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5">{tag}</span>
                                  ))}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="rounded-lg bg-muted/35 px-3 py-4 text-sm text-muted-foreground">{t('noMarketTemplates')}</p>
                        )
                      ) : null}
                    </>
                  ) : null}

                  <label className="block text-xs font-medium text-muted-foreground">
                    {t('name')}
                    <input
                      name="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                      maxLength={100}
                      autoFocus
                      className="ui-input mt-1.5 h-10 w-full"
                      placeholder={t('namePlaceholder')}
                    />
                  </label>

                  <label className="block text-xs font-medium text-muted-foreground">
                    {t('description')}
                    <textarea
                      name="description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      rows={2}
                      maxLength={500}
                      className="ui-input mt-1.5 min-h-20 w-full resize-y py-2"
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
                        <button type="button" aria-label={`${t('model')}: ${model || t('selectModel')}`} className="ui-input mt-1.5 flex h-10 w-full items-center gap-2 px-3 text-left text-sm text-foreground">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                            {selectedProvider?.name.charAt(0).toUpperCase() || 'M'}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{model || t('selectModel')}</span>
                          <span className="hidden max-w-36 truncate text-xs text-muted-foreground sm:block">{selectedProvider?.name}</span>
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        </button>
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
                        <button
                          type="button"
                          onClick={() => setShowPromptPreview((current) => !current)}
                          aria-label={showPromptPreview ? t('editSystemPrompt') : t('previewSystemPrompt')}
                          title={showPromptPreview ? t('editSystemPrompt') : t('previewSystemPrompt')}
                          className="ui-button-ghost ui-icon-button size-7"
                        >
                          {showPromptPreview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
                        </button>
                        {promptRestore?.generated === systemPrompt ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSystemPrompt(promptRestore.previous);
                              setPromptRestore(null);
                            }}
                            aria-label={common('undo')}
                            title={common('undo')}
                            className="ui-button-ghost ui-icon-button size-7"
                          >
                            <RotateCcw className="size-3.5" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={!basicComplete || generatingPrompt}
                          onClick={() => void generateSystemPrompt()}
                          className="ui-button-secondary h-7 gap-1.5 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {generatingPrompt ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                          {systemPrompt.trim() ? t('improvePrompt') : t('generatePrompt')}
                        </button>
                      </div>
                    </div>
                    {showPromptPreview ? (
                      <div className="mt-1.5 min-h-64 overflow-auto rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground">
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
                        className="ui-input mt-1.5 min-h-64 w-full resize-y py-2"
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
                    <div className="flex min-h-14 items-center justify-between gap-4 py-2.5">
                      <label className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={temperatureEnabled}
                          onChange={(event) => setTemperatureEnabled(event.target.checked)}
                          aria-label={t('useCustomTemperature')}
                          className="size-4 accent-[var(--brand)]"
                        />
                        <span>{t('temperature')}</span>
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={2}
                        step={0.1}
                        value={temperature}
                        disabled={!temperatureEnabled}
                        onChange={(event) => {
                          if (Number.isFinite(event.currentTarget.valueAsNumber)) {
                            setTemperature(event.currentTarget.valueAsNumber);
                          }
                        }}
                        aria-label={t('temperature')}
                        className="ui-input h-8 w-24 text-right disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <div className="flex min-h-14 items-center justify-between gap-4 py-2.5">
                      <label className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={topPEnabled}
                          onChange={(event) => setTopPEnabled(event.target.checked)}
                          aria-label={t('useCustomTopP')}
                          className="size-4 accent-[var(--brand)]"
                        />
                        <span>{t('topP')}</span>
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={topP}
                        disabled={!topPEnabled}
                        onChange={(event) => {
                          if (Number.isFinite(event.currentTarget.valueAsNumber)) {
                            setTopP(event.currentTarget.valueAsNumber);
                          }
                        }}
                        aria-label={t('topP')}
                        className="ui-input h-8 w-24 text-right disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <div className="flex min-h-14 items-center justify-between gap-4 py-2.5">
                      <label className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={maxOutputTokensEnabled}
                          onChange={(event) => setMaxOutputTokensEnabled(event.target.checked)}
                          aria-label={t('useCustomMaxOutputTokens')}
                          className="size-4 accent-[var(--brand)]"
                        />
                        <span>{t('maxOutputTokens')}</span>
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={1_000_000}
                        step={1}
                        value={maxOutputTokens}
                        disabled={!maxOutputTokensEnabled}
                        onChange={(event) => {
                          if (Number.isFinite(event.currentTarget.valueAsNumber)) {
                            setMaxOutputTokens(event.currentTarget.valueAsNumber);
                          }
                        }}
                        aria-label={t('maxOutputTokens')}
                        className="ui-input h-8 w-28 text-right disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                  </div>
                  <div className="border-b border-border pb-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-medium text-foreground">{t('customParameters')}</h4>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('customParametersHint')}</p>
                      </div>
                      <button type="button" onClick={() => setCustomParameters((current) => [
                        ...current,
                        { name: '', type: 'string', value: '' },
                      ])} className="ui-button-secondary h-8 shrink-0 gap-1.5 px-2.5 text-xs">
                        <Plus className="size-3.5" />
                        {t('addCustomParameter')}
                      </button>
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
                                <input
                                  value={parameter.name}
                                  onChange={(event) => updateParameter({ name: event.target.value })}
                                  aria-label={t('customParameterName')}
                                  className="ui-input h-8 w-full"
                                  placeholder="top_k"
                                />
                                <select
                                  value={parameter.type}
                                  onChange={(event) => updateParameter({ type: event.target.value as AssistantCustomParameter['type'] })}
                                  aria-label={t('customParameterType')}
                                  className="ui-input h-8 w-full"
                                >
                                  <option value="string">string</option>
                                  <option value="number">number</option>
                                  <option value="boolean">boolean</option>
                                  <option value="json">json</option>
                                </select>
                                {parameter.type === 'number' ? (
                                  <input
                                    type="number"
                                    value={typeof parameter.value === 'number' ? parameter.value : 0}
                                    onChange={(event) => updateParameter({ value: Number.isFinite(event.currentTarget.valueAsNumber) ? event.currentTarget.valueAsNumber : 0 })}
                                    aria-label={valueLabel}
                                    className="ui-input h-8 w-full"
                                  />
                                ) : parameter.type === 'boolean' ? (
                                  <select
                                    value={String(parameter.value)}
                                    onChange={(event) => updateParameter({ value: event.target.value === 'true' })}
                                    aria-label={valueLabel}
                                    className="ui-input h-8 w-full"
                                  >
                                    <option value="true">true</option>
                                    <option value="false">false</option>
                                  </select>
                                ) : parameter.type === 'json' ? (
                                  <span className="hidden sm:block" />
                                ) : (
                                  <input
                                    value={String(parameter.value)}
                                    onChange={(event) => updateParameter({ value: event.target.value })}
                                    aria-label={valueLabel}
                                    className="ui-input h-8 w-full"
                                  />
                                )}
                                <button
                                  type="button"
                                  onClick={() => setCustomParameters((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                                  aria-label={common('delete')}
                                  title={common('delete')}
                                  className="ui-button-ghost ui-icon-button size-8"
                                >
                                  <Trash2 className="size-3.5" />
                                </button>
                              </div>
                              {parameter.type === 'json' ? (
                                <textarea
                                  value={String(parameter.value)}
                                  onChange={(event) => updateParameter({ value: event.target.value })}
                                  aria-label={valueLabel}
                                  rows={3}
                                  spellCheck={false}
                                  className="ui-input mt-2 w-full resize-y py-2 font-mono text-xs"
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

                  <label className="block max-w-44 text-xs font-medium text-muted-foreground">
                    {t('maxToolSteps')}
                    <input
                      name="maxSteps"
                      type="number"
                      min={AGENT_STEP_BOUNDS.min}
                      max={AGENT_STEP_BOUNDS.max}
                      defaultValue={assistant?.maxSteps ?? marketTemplate?.maxSteps ?? AGENT_STEP_BOUNDS.default}
                      className="ui-input mt-1.5 h-9 w-full"
                    />
                  </label>

                  <fieldset>
                    <legend className={creating ? 'sr-only' : 'text-xs font-medium text-muted-foreground'}>{t('mcpAccess')}</legend>
                    {!creating ? <p className="mt-1 text-xs text-muted-foreground">{t('mcpDescription')}</p> : null}
                    {marketTemplate?.missingMcpNames?.length ? (
                      <p role="alert" className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                        {t('marketTemplateMissingMcp', { names: marketTemplate.missingMcpNames.join(', ') })}{' '}
                        <Link href={`/app/${encodeURIComponent(slug)}/market/mcp`} className="font-medium underline">
                          {t('browseMcpMarket')}
                        </Link>
                      </p>
                    ) : null}
                    <div className="mt-2 divide-y divide-border border-y border-border">
                      {deployments.length ? deployments.map((deployment) => (
                        <label key={deployment.id} className="flex min-h-10 items-center gap-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            name="deploymentIds"
                            value={deployment.id}
                            defaultChecked={assistant?.deploymentIds.includes(deployment.id) || marketTemplate?.deploymentIds.includes(deployment.id)}
                            className="size-4 accent-[var(--brand)]"
                          />
                          <span className="min-w-0 flex-1 truncate">{deployment.name}</span>
                          <span className={cx(
                            'text-[11px]',
                            deployment.status === 'running' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                          )}>{deployment.status}</span>
                        </label>
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
                  <button
                    type="button"
                    onClick={() => void onDelete(assistant.id)}
                    className="ui-button-secondary ui-button-danger-secondary h-9 px-3 text-sm"
                  >
                    <Trash2 className="size-4" />
                    {common('delete')}
                  </button>
                </div>
              ) : null}
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="ui-button-secondary h-9 px-4 text-sm">
                  {common('cancel')}
                </button>
                {creating && createStepIndex > 0 ? (
                  <button
                    type="button"
                    onClick={() => setCreateStep(createSteps[createStepIndex - 1]!.id)}
                    className="ui-button-secondary h-9 gap-2 px-4 text-sm"
                  >
                    <ChevronLeft className="size-4" />
                    {t('back')}
                  </button>
                ) : null}
                {creating && !lastCreateStep ? (
                  <button
                    type="button"
                    disabled={createStep === 'basic' && !basicComplete}
                    onClick={(event) => {
                      if (!event.currentTarget.form?.reportValidity()) return;
                      setCreateStep(createSteps[createStepIndex + 1]!.id);
                    }}
                    className="ui-button-primary h-9 gap-2 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('next')}
                    <ChevronRight className="size-4" />
                  </button>
                ) : null}
                {creating && lastCreateStep ? (
                  <button type="submit" disabled={saving || !basicComplete} className="ui-button-primary h-9 gap-2 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50">
                    <Plus className="size-4" />
                    {saving ? t('saving') : t('createAssistant')}
                  </button>
                ) : null}
                {!creating ? (
                  <button type="submit" disabled={saving} className="ui-button-primary h-9 px-4 text-sm">
                    {saving ? t('saving') : common('save')}
                  </button>
                ) : null}
              </div>
            </footer>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

export function WorkspaceAssistantChat({
  assistants,
  branch = null,
  deployments,
  initialMessages,
  marketTemplate = null,
  marketTemplates = [],
  providers,
  reasoningAvailable,
  selectedAssistantId,
  selectedThreadId,
  slug,
  startCreating = false,
  initialExpandedAssistants = EMPTY_EXPANDED_ASSISTANTS,
  initialGroupPreferences = EMPTY_SIDEBAR_GROUP_PREFERENCES,
  initialSidebarOpen = true,
  workspaceId,
}: {
  assistants: ChatAssistantItem[];
  branch?: ChatBranchState | null;
  deployments: McpOption[];
  initialMessages: HermesUIMessage[];
  marketTemplate?: AssistantMarketTemplate | null;
  marketTemplates?: AssistantMarketTemplate[];
  providers: ProviderOption[];
  reasoningAvailable: boolean;
  selectedAssistantId: string | null;
  selectedThreadId: string | null;
  slug: string;
  startCreating?: boolean;
  initialExpandedAssistants?: Record<string, boolean>;
  initialGroupPreferences?: SidebarGroupPreferences;
  initialSidebarOpen?: boolean;
  workspaceId: string;
}) {
  const t = useTranslations('console.chatAssistants');
  const common = useTranslations('common');
  const router = useRouter();
  const activeAssistant = assistants.find((assistant) => assistant.id === selectedAssistantId) ?? assistants[0] ?? null;
  const activeThread = activeAssistant?.threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const [query, setQuery] = useState('');
  const [expandedAssistants, setExpandedAssistants] = usePersistentBooleanRecord(
    `toolplane:assistant-chat-expanded:${workspaceId}`,
    initialExpandedAssistants,
    assistantChatExpandedCookieName(workspaceId),
  );
  const [groupPreferences, setGroupPreferences] = usePersistentSidebarGroups(
    `toolplane:assistant-chat-groups:${workspaceId}`,
    initialGroupPreferences,
    assistantChatGroupPreferencesCookieName(workspaceId),
  );
  const [sidebarOpen, setSidebarOpen] = usePersistentBoolean(
    `toolplane:assistant-chat-sidebar:${workspaceId}`,
    initialSidebarOpen,
    assistantChatSidebarCookieName(workspaceId),
  );
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchMaximized, setBranchMaximized] = useState(false);
  const [branchMutating, setBranchMutating] = useState(false);
  const focusBranchMessageIdRef = useRef<string | null>(null);
  const [branchRefreshPending, startBranchRefresh] = useTransition();
  const [mobilePane, setMobilePane] = useState<'sidebar' | 'chat'>(activeThread ? 'chat' : 'sidebar');
  const [editing, setEditing] = useState<ChatAssistantItem | null | 'new'>(startCreating ? 'new' : null);
  const [selectedMarketTemplate, setSelectedMarketTemplate] = useState(marketTemplate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggingThread, setDraggingThread] = useState<{ id: string; assistantId: string } | null>(null);
  const draggingThreadRef = useRef<{ id: string; assistantId: string } | null>(null);
  const [dropAssistantId, setDropAssistantId] = useState<string | null>(null);
  const [groupEditor, setGroupEditor] = useState<{ id: string | null; name: string } | null>(null);
  const [draggingAssistantId, setDraggingAssistantId] = useState<string | null>(null);
  const draggingAssistantIdRef = useRef<string | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const branchBusy = branchMutating || branchRefreshPending;
  const refreshChat = useCallback(() => {
    startBranchRefresh(() => router.refresh());
  }, [router]);
  const visibleAssistants = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return assistants;
    return assistants.flatMap((assistant) => {
      const assistantMatches = assistant.name.toLocaleLowerCase().includes(needle);
      const threads = assistant.threads.filter((thread) => (thread.title || t('newChat')).toLocaleLowerCase().includes(needle));
      return assistantMatches || threads.length ? [{ ...assistant, threads: assistantMatches ? assistant.threads : threads }] : [];
    });
  }, [assistants, query, t]);
  const groupedAssistants = useMemo(() => {
    const assistantsByGroup = new Map<string, ChatAssistantItem[]>(
      groupPreferences.groups.map((group) => [group.id, []]),
    );
    const ungrouped: ChatAssistantItem[] = [];
    for (const assistant of visibleAssistants) {
      const group = assistantsByGroup.get(groupPreferences.assignments[assistant.id] ?? '');
      if (group) group.push(assistant);
      else ungrouped.push(assistant);
    }
    return {
      groups: groupPreferences.groups.map((group) => ({
        group,
        assistants: assistantsByGroup.get(group.id) ?? [],
      })),
      ungrouped,
    };
  }, [groupPreferences.assignments, groupPreferences.groups, visibleAssistants]);

  useEffect(() => {
    if (!focusBranchMessageIdRef.current || branch?.activeMessageId !== focusBranchMessageIdRef.current) return;
    document.querySelector<HTMLTextAreaElement>('[data-ui="chat.composer"] textarea')?.focus();
    focusBranchMessageIdRef.current = null;
  }, [branch?.activeMessageId]);

  async function switchBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    const node = branch?.nodes.find((candidate) => candidate.id === messageId);
    if (node?.active) {
      document.getElementById(`chat-message-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setBranchMutating(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/threads/${activeThread.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activeMessageId: messageId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || t('branchSwitchError'));
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('branchSwitchError'));
    } finally {
      setBranchMutating(false);
    }
  }

  async function startBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    setBranchMutating(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/threads/${activeThread.id}/branches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      const body = await response.json().catch(() => ({})) as {
        branch?: { activeMessageId?: string | null; activated?: boolean };
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || t('branchCreateError'));
      if (body.branch?.activated && body.branch.activeMessageId) {
        focusBranchMessageIdRef.current = body.branch.activeMessageId;
      }
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('branchCreateError'));
    } finally {
      setBranchMutating(false);
    }
  }

  async function deleteBranch(messageId: string) {
    if (!activeThread || branchBusy) return;
    setBranchMutating(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/threads/${activeThread.id}/branches`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || t('branchDeleteError'));
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('branchDeleteError'));
    } finally {
      setBranchMutating(false);
    }
  }

  async function createThread(assistantId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/assistants/${assistantId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({})) as { thread?: { id?: string }; id?: string; error?: string };
      const threadId = body.thread?.id ?? body.id;
      if (!response.ok || !threadId) throw new Error(body.error || t('threadCreateError'));
      setExpandedAssistants((current) => ({ ...current, [assistantId]: true }));
      openAssistantGroup(assistantId);
      window.location.assign(chatHref(slug, assistantId, threadId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('threadCreateError'));
      setBusy(false);
    }
  }

  async function moveThread(threadId: string, targetAssistantId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantId: targetAssistantId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || t('moveThreadError'));
      setExpandedAssistants((current) => ({ ...current, [targetAssistantId]: true }));
      openAssistantGroup(targetAssistantId);
      router.push(chatHref(slug, targetAssistantId, threadId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('moveThreadError'));
    } finally {
      setBusy(false);
      draggingThreadRef.current = null;
      setDraggingThread(null);
      setDropAssistantId(null);
    }
  }

  async function deleteThread(threadId: string) {
    if (!window.confirm(t('deleteThreadConfirm'))) return;
    const response = await fetch(`/api/v1/chat/threads/${threadId}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(t('deleteError'));
      return;
    }
    window.location.assign(activeAssistant ? chatHref(slug, activeAssistant.id) : `/app/${encodeURIComponent(slug)}/chat`);
  }

  async function deleteAssistant(assistantId: string) {
    if (!window.confirm(t('deleteAssistantConfirm'))) return;
    const response = await fetch(`/api/v1/chat/assistants/${assistantId}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(t('deleteError'));
      return;
    }
    window.location.assign(`/app/${encodeURIComponent(slug)}/chat`);
  }

  async function toggleAssistantPin(assistant: ChatAssistantItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/assistants/${assistant.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: !assistant.pinned }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || t('saveError'));
      refreshChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  }

  async function assistantSaved(assistantId: string, created: boolean) {
    setEditing(null);
    if (created) {
      await createThread(assistantId);
      return;
    }
    window.location.assign(chatHref(slug, assistantId, activeThread?.id));
  }

  async function updateAssistantModel(selection: ModelSelection) {
    if (!activeAssistant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/chat/assistants/${activeAssistant.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelProviderId: selection.providerId, model: selection.model }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || t('saveError'));
      window.location.assign(chatHref(slug, activeAssistant.id, activeThread?.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveError'));
      setBusy(false);
    }
  }

  function openAssistantGroup(assistantId: string) {
    setGroupPreferences((current) => {
      const groupId = current.assignments[assistantId];
      if (!groupId || !current.collapsed[groupId]) return current;
      return { ...current, collapsed: { ...current.collapsed, [groupId]: false } };
    });
  }

  function setAllAssistantSections(collapsed: boolean) {
    setExpandedAssistants(Object.fromEntries(assistants.map((assistant) => [assistant.id, !collapsed])));
    setGroupPreferences((current) => {
      if (!current.groups.length) return current;
      return {
        ...current,
        collapsed: Object.fromEntries([
          ...current.groups.map((group) => [group.id, collapsed]),
          [UNGROUPED_SIDEBAR_GROUP_ID, collapsed],
        ]),
      };
    });
  }

  function saveAssistantGroup(name: string) {
    if (!groupEditor) return;
    setGroupPreferences((current) => {
      if (groupEditor.id) {
        return {
          ...current,
          groups: current.groups.map((group) => (
            group.id === groupEditor.id ? { ...group, name } : group
          )),
        };
      }
      const id = createSidebarGroupId();
      return {
        ...current,
        groups: [...current.groups, { id, name }],
        collapsed: { ...current.collapsed, [id]: false },
      };
    });
    setGroupEditor(null);
  }

  function deleteAssistantGroup(groupId: string) {
    const group = groupPreferences.groups.find((item) => item.id === groupId);
    if (!group || !window.confirm(t('deleteGroupConfirm', { name: group.name }))) return;
    setGroupPreferences((current) => {
      const assignments = Object.fromEntries(
        Object.entries(current.assignments).filter(([, assignedGroupId]) => assignedGroupId !== groupId),
      );
      const collapsed = { ...current.collapsed };
      delete collapsed[groupId];
      return {
        ...current,
        groups: current.groups.filter((item) => item.id !== groupId),
        assignments,
        collapsed,
      };
    });
  }

  function assignAssistantToGroup(assistantId: string, groupId: string | null) {
    setGroupPreferences((current) => {
      const assignments = { ...current.assignments };
      if (groupId) assignments[assistantId] = groupId;
      else delete assignments[assistantId];
      return {
        ...current,
        assignments,
        ...(groupId ? { collapsed: { ...current.collapsed, [groupId]: false } } : {}),
      };
    });
  }

  function renderAssistant(assistant: ChatAssistantItem) {
    const expanded = Boolean(query) || (expandedAssistants[assistant.id] ?? true);
    return (
      <li key={assistant.id} className="py-0.5">
        <div
          onDragOver={(event) => {
            const dragged = draggingThreadRef.current;
            if (!dragged || dragged.assistantId === assistant.id || busy) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropAssistantId(assistant.id);
          }}
          onDrop={(event) => {
            const dragged = draggingThreadRef.current;
            if (!dragged || dragged.assistantId === assistant.id || busy) return;
            event.preventDefault();
            const threadId = dragged.id;
            draggingThreadRef.current = null;
            setDraggingThread(null);
            setDropAssistantId(null);
            void moveThread(threadId, assistant.id);
          }}
          className={cx(
            'group flex h-8 items-center gap-1.5 rounded-lg px-1.5',
            assistant.id === activeAssistant?.id ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60',
            dropAssistantId === assistant.id && 'ring-1 ring-inset ring-brand/50',
            draggingAssistantId === assistant.id && 'opacity-50',
          )}
        >
          <button
            type="button"
            draggable={!busy}
            aria-label={t('moveToGroup')}
            title={t('moveToGroup')}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-toolplane-assistant', assistant.id);
              draggingAssistantIdRef.current = assistant.id;
              setDraggingAssistantId(assistant.id);
            }}
            onDragEnd={() => {
              draggingAssistantIdRef.current = null;
              setDraggingAssistantId(null);
              setDropGroupId(null);
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <GripVertical className="size-3.5" />
          </button>
          <Link href={chatHref(slug, assistant.id)} onClick={() => setMobilePane('chat')} className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground"><Bot className="size-3.5" /></span>
            <span className="min-w-0 flex-1 truncate">{assistant.name}</span>
          </Link>
          <button
            type="button"
            aria-label={assistant.name}
            aria-expanded={expanded}
            aria-controls={`assistant-chat-threads-${assistant.id}`}
            title={expanded ? t('hideConversations') : t('showConversations')}
            onClick={() => setExpandedAssistants((current) => ({ ...current, [assistant.id]: !expanded }))}
            className="-ml-1.5 hidden size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex hover:bg-background hover:text-foreground"
          >
            <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
          </button>
          <SidebarActionRail hasLeadingSlot revealOnCellFocus>
            <SidebarEntityActionsMenu
              actionsLabel={t('assistantActions', { name: assistant.name })}
              deleteLabel={common('delete')}
              editLabel={common('edit')}
              onDelete={() => void deleteAssistant(assistant.id)}
              onEdit={() => setEditing(assistant)}
              onTogglePin={() => void toggleAssistantPin(assistant)}
              pinned={assistant.pinned}
              pinLabel={t('pinAssistant')}
              unpinLabel={t('unpinAssistant')}
            />
            <button type="button" onClick={() => void createThread(assistant.id)} aria-label={t('newChatFor', { name: assistant.name })} title={t('newChat')} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
              <Plus className="size-3.5" />
            </button>
          </SidebarActionRail>
        </div>
        {expanded ? (
          <ul id={`assistant-chat-threads-${assistant.id}`} className="ml-4 py-0.5 pl-1">
            {assistant.threads.length > 0 ? assistant.threads.map((thread) => (
            <ContextMenu.Root key={thread.id} modal={false}>
              <ContextMenu.Trigger asChild>
                <li
                  draggable={!busy}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', thread.id);
                    draggingThreadRef.current = { id: thread.id, assistantId: assistant.id };
                    setDraggingThread({ id: thread.id, assistantId: assistant.id });
                  }}
                  onDragEnd={() => {
                    draggingThreadRef.current = null;
                    setDraggingThread(null);
                    setDropAssistantId(null);
                  }}
                  className={cx(
                    'group group/thread relative py-0.5',
                    draggingThread?.id === thread.id && 'opacity-50',
                  )}
                >
                  <Link
                    draggable={false}
                    href={chatHref(slug, assistant.id, thread.id)}
                    onClick={() => setMobilePane('chat')}
                    aria-current={thread.id === activeThread?.id ? 'page' : undefined}
                    title={thread.lastMessageAt ?? thread.createdAt}
                    className={cx(
                      'flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 pr-7 text-[13px] transition-colors group-data-[state=open]/thread:bg-muted/60',
                      thread.id === activeThread?.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/75 hover:bg-muted/60',
                    )}
                  >
                    <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{thread.title || t('newChat')}</span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => void deleteThread(thread.id)}
                    aria-label={t('deleteThread')}
                    title={t('deleteThread')}
                    className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/thread:opacity-100 focus:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger
                      disabled={assistants.length < 2 || busy}
                      className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                    >
                      <MoveRight className="size-3.5 shrink-0 text-muted-foreground" />
                      {t('moveThreadTo')}
                      <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent className="z-50 min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                        {assistants.filter((target) => target.id !== assistant.id).map((target) => (
                          <ContextMenu.Item
                            key={target.id}
                            onSelect={() => void moveThread(thread.id, target.id)}
                            className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                          >
                            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{target.name}</span>
                          </ContextMenu.Item>
                        ))}
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
            )) : (
              <li className="flex h-8 items-center px-2 text-xs text-muted-foreground">{t('noConversations')}</li>
            )}
          </ul>
        ) : null}
      </li>
    );
  }

  function renderAssistantGroup(groupId: string, name: string, groupAssistants: ChatAssistantItem[], editable: boolean) {
    const expanded = Boolean(query) || !groupPreferences.collapsed[groupId];
    const targetGroupId = editable ? groupId : null;
    const label = expanded ? t('hideGroup', { name }) : t('showGroup', { name });
    return (
      <li key={groupId} data-sidebar-group-id={groupId} className="py-1">
        <div
          onDragOver={(event) => {
            const assistantId = draggingAssistantIdRef.current;
            const assignedGroupId = assistantId ? groupPreferences.assignments[assistantId] ?? null : null;
            if (!assistantId || assignedGroupId === targetGroupId) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropGroupId(groupId);
          }}
          onDrop={(event) => {
            const assistantId = draggingAssistantIdRef.current;
            if (!assistantId) return;
            event.preventDefault();
            assignAssistantToGroup(assistantId, targetGroupId);
            draggingAssistantIdRef.current = null;
            setDraggingAssistantId(null);
            setDropGroupId(null);
          }}
          className={cx(
            'group/sidebar-group flex h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground',
            dropGroupId === groupId && 'bg-muted ring-1 ring-inset ring-brand/50',
          )}
        >
          <button
            type="button"
            aria-label={label}
            aria-expanded={expanded}
            aria-controls={`assistant-sidebar-group-${groupId}`}
            title={label}
            onClick={() => setGroupPreferences((current) => ({
              ...current,
              collapsed: { ...current.collapsed, [groupId]: !current.collapsed[groupId] },
            }))}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
          >
            <Folder className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="text-[10px] text-muted-foreground">{groupAssistants.length}</span>
            <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
          </button>
          {editable ? (
            <>
              <button type="button" aria-label={t('renameGroup')} title={t('renameGroup')} onClick={() => setGroupEditor({ id: groupId, name })} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-background hover:text-foreground">
                <Pencil className="size-3.5" />
              </button>
              <button type="button" aria-label={t('deleteGroup')} title={t('deleteGroup')} onClick={() => deleteAssistantGroup(groupId)} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-background hover:text-destructive">
                <Trash2 className="size-3.5" />
              </button>
            </>
          ) : null}
        </div>
        {expanded ? (
          <ul id={`assistant-sidebar-group-${groupId}`} className="ml-2 border-l border-border/60 py-0.5 pl-1">
            {groupAssistants.map(renderAssistant)}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <>
      <div className="relative flex h-full min-h-0 overflow-hidden bg-background">
        <div className={cx(
          'grid min-h-0 flex-1 grid-cols-1',
          sidebarOpen && 'lg:grid-cols-[15rem_minmax(0,1fr)] min-[1024px]:max-[1080px]:grid-cols-[13.125rem_minmax(0,1fr)]!',
          branchOpen && !branchMaximized && (sidebarOpen
            ? 'xl:grid-cols-[15rem_minmax(0,1fr)_20rem]'
            : 'xl:grid-cols-[minmax(0,1fr)_20rem]'),
        )}>
          <aside
            aria-label={t('assistants')}
            className={cx(
              'min-h-0 flex-col overflow-hidden bg-background p-1.5',
              mobilePane === 'chat' ? (sidebarOpen ? 'hidden lg:flex' : 'hidden') : (sidebarOpen ? 'flex' : 'flex lg:hidden'),
            )}
          >
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery('')}
              label={t('search')}
              clearLabel={t('clearSearch')}
              placeholder={t('search')}
              controlSize="sm"
              wrapperClassName="px-0.5"
              className="h-7 rounded-full border-0 bg-muted/70 text-[11px] focus:ring-1 focus:ring-brand/35"
            />
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
              <div className="flex h-8 items-center gap-1 px-1">
                <button type="button" onClick={() => { setSelectedMarketTemplate(null); setEditing('new'); }} aria-label={t('newAssistant')} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-foreground hover:bg-muted">
                  <Plus className="size-3.5 shrink-0" />
                  <span className="truncate">{t('newAssistant')}</span>
                </button>
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button type="button" aria-label={t('listOptions')} title={t('listOptions')} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                      <ListFilter className="size-3.5" />
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content side="bottom" align="end" sideOffset={4} aria-label={t('listOptions')} className="z-50 w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                      <p className="px-2.5 py-1 text-xs text-muted-foreground">{t('listOptions')}</p>
                      {assistants.length ? (
                        <>
                          <Popover.Close asChild>
                            <button type="button" onClick={() => setAllAssistantSections(false)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent">
                              <ChevronsUpDown className="size-4" />
                              {t('expandAll')}
                            </button>
                          </Popover.Close>
                          <Popover.Close asChild>
                            <button type="button" onClick={() => setAllAssistantSections(true)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent">
                              <ChevronsDownUp className="size-4" />
                              {t('collapseAll')}
                            </button>
                          </Popover.Close>
                        </>
                      ) : null}
                      <div className="my-1 h-px bg-border" />
                      <Popover.Close asChild>
                        <button type="button" onClick={() => setGroupEditor({ id: null, name: '' })} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent">
                          <FolderPlus className="size-4" />
                          {t('newGroup')}
                        </button>
                      </Popover.Close>
                      <Popover.Close asChild>
                        <Link href={`/app/${encodeURIComponent(slug)}/market/assistants`} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-accent">
                          <Store className="size-4" />
                          {t('chooseFromMarket')}
                        </Link>
                      </Popover.Close>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </div>
              {groupPreferences.groups.length ? (
                <ul>
                  {groupedAssistants.groups.map(({ group, assistants: groupAssistants }) => (
                    !query || groupAssistants.length ? renderAssistantGroup(group.id, group.name, groupAssistants, true) : null
                  ))}
                  {!query || groupedAssistants.ungrouped.length ? renderAssistantGroup(
                    UNGROUPED_SIDEBAR_GROUP_ID,
                    t('ungrouped'),
                    groupedAssistants.ungrouped,
                    false,
                  ) : null}
                </ul>
              ) : (
              <ul>
                {visibleAssistants.map((assistant) => {
                  const expanded = Boolean(query) || (expandedAssistants[assistant.id] ?? true);
                  return (
                    <li key={assistant.id} className="py-0.5">
                      <div
                        onDragOver={(event) => {
                          const dragged = draggingThreadRef.current;
                          if (!dragged || dragged.assistantId === assistant.id || busy) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          setDropAssistantId(assistant.id);
                        }}
                        onDrop={(event) => {
                          const dragged = draggingThreadRef.current;
                          if (!dragged || dragged.assistantId === assistant.id || busy) return;
                          event.preventDefault();
                          const threadId = dragged.id;
                          draggingThreadRef.current = null;
                          setDraggingThread(null);
                          setDropAssistantId(null);
                          void moveThread(threadId, assistant.id);
                        }}
                        className={cx(
                          'group flex h-8 items-center gap-1.5 rounded-lg px-1.5',
                          assistant.id === activeAssistant?.id ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60',
                          dropAssistantId === assistant.id && 'ring-1 ring-inset ring-brand/50',
                        )}
                      >
                        <Link href={chatHref(slug, assistant.id)} onClick={() => setMobilePane('chat')} className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground"><Bot className="size-3.5" /></span>
                          <span className="min-w-0 flex-1 truncate">{assistant.name}</span>
                        </Link>
                        <button
                          type="button"
                          aria-label={assistant.name}
                          aria-expanded={expanded}
                          aria-controls={`assistant-chat-threads-${assistant.id}`}
                          title={expanded ? t('hideConversations') : t('showConversations')}
                          onClick={() => setExpandedAssistants((current) => ({ ...current, [assistant.id]: !expanded }))}
                          className="-ml-1.5 hidden size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex hover:bg-background hover:text-foreground"
                        >
                          <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
                        </button>
                        <SidebarActionRail hasLeadingSlot revealOnCellFocus>
                          <SidebarEntityActionsMenu
                            actionsLabel={t('assistantActions', { name: assistant.name })}
                            deleteLabel={common('delete')}
                            editLabel={common('edit')}
                            onDelete={() => void deleteAssistant(assistant.id)}
                            onEdit={() => setEditing(assistant)}
                            onTogglePin={() => void toggleAssistantPin(assistant)}
                            pinned={assistant.pinned}
                            pinLabel={t('pinAssistant')}
                            unpinLabel={t('unpinAssistant')}
                          />
                          <button type="button" onClick={() => void createThread(assistant.id)} aria-label={t('newChatFor', { name: assistant.name })} title={t('newChat')} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
                            <Plus className="size-3.5" />
                          </button>
                        </SidebarActionRail>
                      </div>
                      {expanded ? (
                        <ul id={`assistant-chat-threads-${assistant.id}`} className="ml-4 py-0.5 pl-1">
                          {assistant.threads.length > 0 ? assistant.threads.map((thread) => (
                          <ContextMenu.Root key={thread.id} modal={false}>
                            <ContextMenu.Trigger asChild>
                              <li
                                draggable={!busy}
                                onDragStart={(event) => {
                                  event.dataTransfer.effectAllowed = 'move';
                                  event.dataTransfer.setData('text/plain', thread.id);
                                  draggingThreadRef.current = { id: thread.id, assistantId: assistant.id };
                                  setDraggingThread({ id: thread.id, assistantId: assistant.id });
                                }}
                                onDragEnd={() => {
                                  draggingThreadRef.current = null;
                                  setDraggingThread(null);
                                  setDropAssistantId(null);
                                }}
                                className={cx(
                                  'group group/thread relative py-0.5',
                                  draggingThread?.id === thread.id && 'opacity-50',
                                )}
                              >
                                <Link
                                  draggable={false}
                                  href={chatHref(slug, assistant.id, thread.id)}
                                  onClick={() => setMobilePane('chat')}
                                  aria-current={thread.id === activeThread?.id ? 'page' : undefined}
                                  title={thread.lastMessageAt ?? thread.createdAt}
                                  className={cx(
                                    'flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 pr-7 text-[13px] transition-colors group-data-[state=open]/thread:bg-muted/60',
                                    thread.id === activeThread?.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/75 hover:bg-muted/60',
                                  )}
                                >
                                  <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                                  <span className="min-w-0 flex-1 truncate">{thread.title || t('newChat')}</span>
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => void deleteThread(thread.id)}
                                  aria-label={t('deleteThread')}
                                  title={t('deleteThread')}
                                  className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/thread:opacity-100 focus:opacity-100"
                                >
                                  <X className="size-3.5" />
                                </button>
                              </li>
                            </ContextMenu.Trigger>
                            <ContextMenu.Portal>
                              <ContextMenu.Content className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                                <ContextMenu.Sub>
                                  <ContextMenu.SubTrigger
                                    disabled={assistants.length < 2 || busy}
                                    className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                                  >
                                    <MoveRight className="size-3.5 shrink-0 text-muted-foreground" />
                                    {t('moveThreadTo')}
                                    <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
                                  </ContextMenu.SubTrigger>
                                  <ContextMenu.Portal>
                                    <ContextMenu.SubContent className="z-50 min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                                      {assistants.filter((target) => target.id !== assistant.id).map((target) => (
                                        <ContextMenu.Item
                                          key={target.id}
                                          onSelect={() => void moveThread(thread.id, target.id)}
                                          className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                                        >
                                          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                                          <span className="truncate">{target.name}</span>
                                        </ContextMenu.Item>
                                      ))}
                                    </ContextMenu.SubContent>
                                  </ContextMenu.Portal>
                                </ContextMenu.Sub>
                              </ContextMenu.Content>
                            </ContextMenu.Portal>
                          </ContextMenu.Root>
                          )) : (
                            <li className="flex h-8 items-center px-2 text-xs text-muted-foreground">{t('noConversations')}</li>
                          )}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              )}
              {!visibleAssistants.length ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('empty')}</p> : null}
            </div>
          </aside>

          <section className={cx(
            'min-h-0 min-w-0 flex-col overflow-hidden bg-background',
            mobilePane === 'sidebar' ? 'hidden lg:flex' : 'flex',
          )}>
            <header className="flex h-11 shrink-0 items-center justify-between gap-3 bg-background px-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t('showSidebar')}
                  title={t('showSidebar')}
                  onClick={() => setMobilePane('sidebar')}
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
                >
                  <PanelLeftOpen className="size-[18px]" />
                </button>
                <button
                  type="button"
                  aria-label={sidebarOpen ? t('hideSidebar') : t('showSidebar')}
                  title={sidebarOpen ? t('hideSidebar') : t('showSidebar')}
                  aria-pressed={sidebarOpen}
                  onClick={() => setSidebarOpen((open) => !open)}
                  className="hidden size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:flex"
                >
                  {sidebarOpen ? <PanelLeftClose className="size-[18px]" /> : <PanelLeftOpen className="size-[18px]" />}
                </button>
                {activeAssistant ? (
                  <>
                    <button type="button" onClick={() => setEditing(activeAssistant)} aria-label={`${t('settings')}: ${activeAssistant.name}`} title={t('settings')} className="ml-0.5 flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium hover:bg-muted">
                      <span className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground"><Bot className="size-3" /></span>
                      <span className="max-w-44 truncate">{activeAssistant.name}</span>
                    </button>
                    <ModelPicker
                      providers={providers}
                      value={activeAssistant.modelProviderId && activeAssistant.model
                        ? { providerId: activeAssistant.modelProviderId, model: activeAssistant.model }
                        : null}
                      pending={busy}
                      onSelect={(selection) => void updateAssistantModel(selection)}
                      onConfigure={() => {
                        window.location.assign(`/app/${encodeURIComponent(slug)}/providers`);
                      }}
                      trigger={(
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`${t('model')}: ${activeAssistant.model ?? t('modelMissing')}`}
                          className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                          <Cpu className="size-4 shrink-0" />
                          <span className="hidden max-w-52 truncate sm:block">{activeAssistant.model ?? t('modelMissing')}</span>
                          <ChevronDown className="size-3 shrink-0" />
                        </button>
                      )}
                    />
                  </>
                ) : null}
              </div>
              {activeThread && branch ? (
                <button
                  type="button"
                  onClick={() => setBranchOpen((value) => {
                    if (value) setBranchMaximized(false);
                    return !value;
                  })}
                  aria-label={branchOpen ? t('hideBranches') : t('showBranches')}
                  aria-pressed={branchOpen}
                  title={t('conversationBranches')}
                  className={cx('flex size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground', branchOpen && 'bg-muted text-foreground')}
                >
                  <GitBranch className="size-[17px]" />
                </button>
              ) : null}
            </header>
            {error ? <p role="alert" className="mx-4 mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
            {activeAssistant && activeThread ? (
              <AgentConversation
                key={activeThread.id}
                activeConversationId={activeThread.id}
                agentId={activeAssistant.id}
                agentName={activeAssistant.name}
                allowEdit
                allowRegenerate
                apiPath={`/api/v1/chat/threads/${activeThread.id}/turns`}
                attachmentUploadUrl={`/api/v1/workspaces/${workspaceId}/attachments`}
                contextBaseText={activeAssistant.systemPrompt}
                contextWindow={activeAssistant.contextWindow}
                contextWindowEstimated={activeAssistant.contextWindowEstimated}
                creatingConversation={false}
                ensureConversation={async () => activeThread.id}
                includeConversationIdInBody={false}
                initialMessages={initialMessages}
                initialReasoningEffort="default"
                mcpPromptApiPath={`/api/v1/chat/threads/${activeThread.id}/prompts`}
                mcpResourceApiPath={`/api/v1/chat/threads/${activeThread.id}/composer`}
                modelName={activeAssistant.model}
                ready={Boolean(activeAssistant.modelProviderId && activeAssistant.model)}
                reasoningAvailable={reasoningAvailable}
                runtimeKind={null}
                supportsAttachments
                webSearchAvailable={activeAssistant.webSearchAvailable}
                branchBusy={branchBusy}
                branchNavigation={branch?.navigation ?? []}
                onBranchChange={(messageId) => void switchBranch(messageId)}
                onConversationChanged={refreshChat}
                onNewConversation={() => createThread(activeAssistant.id)}
                onStartBranch={(messageId) => void startBranch(messageId)}
              />
            ) : (
              <div className="m-auto max-w-md px-6 text-center">
                <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Bot className="size-5" /></div>
                <h2 className="text-base font-medium">{activeAssistant ? t('noThreadTitle') : t('emptyTitle')}</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{activeAssistant ? t('noThreadDescription') : t('emptyDescription')}</p>
                <button type="button" onClick={() => activeAssistant ? void createThread(activeAssistant.id) : setEditing('new')} className="ui-button-primary mt-4 h-9 px-4 text-sm">
                  <Plus className="size-4" />
                  {activeAssistant ? t('newChat') : t('newAssistant')}
                </button>
              </div>
            )}
          </section>

          {branchOpen && !branchMaximized && activeThread && branch ? (
            <aside className="hidden min-h-0 flex-col overflow-hidden border-l border-border bg-background xl:flex">
              <ChatBranchPanel
                branch={branch}
                busy={branchBusy}
                canMaximize
                onClose={() => setBranchOpen(false)}
                onDelete={(messageId) => void deleteBranch(messageId)}
                onMaximize={() => setBranchMaximized(true)}
                onSelect={(messageId) => void switchBranch(messageId)}
                onStart={(messageId) => void startBranch(messageId)}
              />
            </aside>
          ) : null}
        </div>
      </div>

      {branchOpen && !branchMaximized && activeThread && branch ? (
        <div className="fixed inset-0 z-50 flex justify-end xl:hidden">
          <button type="button" aria-label={common('close')} onClick={() => setBranchOpen(false)} className="absolute inset-0 bg-black/30" />
          <aside className="relative flex h-full w-[min(22rem,92vw)] bg-background shadow-xl">
            <ChatBranchPanel
              branch={branch}
              busy={branchBusy}
              onClose={() => setBranchOpen(false)}
              onDelete={(messageId) => void deleteBranch(messageId)}
              onSelect={(messageId) => void switchBranch(messageId)}
              onStart={(messageId) => void startBranch(messageId)}
            />
          </aside>
        </div>
      ) : null}

      {branchOpen && branchMaximized && activeThread && branch ? (
        <div className="fixed inset-0 z-[70] flex bg-background">
          <ChatBranchPanel
            branch={branch}
            busy={branchBusy}
            canMaximize
            maximized
            onClose={() => {
              setBranchOpen(false);
              setBranchMaximized(false);
            }}
            onDelete={(messageId) => void deleteBranch(messageId)}
            onMaximize={() => setBranchMaximized(false)}
            onSelect={(messageId) => void switchBranch(messageId)}
            onStart={(messageId) => void startBranch(messageId)}
          />
        </div>
      ) : null}

      <SidebarGroupDialog
        initialName={groupEditor?.name ?? ''}
        open={Boolean(groupEditor)}
        title={t(groupEditor?.id ? 'renameGroup' : 'newGroup')}
        nameLabel={t('groupName')}
        placeholder={t('groupNamePlaceholder')}
        cancelLabel={common('cancel')}
        submitLabel={groupEditor?.id ? common('save') : common('create')}
        onClose={() => setGroupEditor(null)}
        onSubmit={saveAssistantGroup}
      />

      {editing ? (
        <AssistantEditor
          key={editing === 'new' ? `new:${selectedMarketTemplate?.releaseId ?? 'blank'}` : editing.id}
          assistant={editing === 'new' ? null : editing}
          deployments={deployments}
          marketTemplate={editing === 'new' ? selectedMarketTemplate : null}
          marketTemplates={marketTemplates}
          onClose={() => setEditing(null)}
          onDelete={deleteAssistant}
          onSaved={assistantSaved}
          onTemplateSelect={setSelectedMarketTemplate}
          open
          providers={providers}
          slug={slug}
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  );
}
