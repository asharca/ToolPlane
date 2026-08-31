'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ContextMenu } from 'radix-ui';
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  MoveRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Store,
  Trash2,
  X,
} from 'lucide-react';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
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
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

type ProviderOption = ModelProviderOption & { format: string };
type McpOption = { id: string; name: string; status: string; keywords?: string[] };
type AssistantCreateStep = 'basic' | 'instructions' | 'tools';

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
  systemPrompt: string | null;
  modelProviderId: string | null;
  model: string | null;
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

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function chatHref(slug: string, assistantId: string, threadId?: string) {
  const query = new URLSearchParams({ assistant: assistantId });
  if (threadId) query.set('thread', threadId);
  return `/app/${encodeURIComponent(slug)}/chat?${query}`;
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
  const [showMarketTemplates, setShowMarketTemplates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createSteps: Array<{ id: AssistantCreateStep; label: string }> = [
    { id: 'basic', label: t('basic') },
    { id: 'instructions', label: t('systemPrompt') },
    { id: 'tools', label: t('mcpAccess') },
  ];
  const createStepIndex = createSteps.findIndex((step) => step.id === createStep);
  const lastCreateStep = createStepIndex === createSteps.length - 1;

  async function submit(formData: FormData) {
    setSaving(true);
    setError(null);
    try {
      const deploymentIds = formData.getAll('deploymentIds').map(String);
      const response = await fetch(
        assistant ? `/api/v1/chat/assistants/${assistant.id}` : '/api/v1/chat/assistants',
        {
          method: assistant ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(!assistant ? { workspaceId } : {}),
            name: String(formData.get('name') ?? '').trim(),
            systemPrompt: String(formData.get('systemPrompt') ?? '').trim() || null,
            modelProviderId: providerId || null,
            model: model || null,
            maxSteps: Number(formData.get('maxSteps') ?? 8),
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
        <DialogContent className={cx(
          '!z-[51] !flex !flex-col !gap-0 !overflow-hidden !rounded-xl !border-border !p-0',
          creating
            ? '!h-[min(600px,calc(100vh-2rem))] !max-w-4xl'
            : '!h-[min(44rem,calc(100vh-2rem))] !max-w-2xl',
        )}>
          <header className={cx(
            'flex shrink-0 items-start gap-3 px-5 py-4',
            !creating && 'border-b border-border',
          )}>
            <div className="min-w-0 flex-1">
              <DialogTitle className="!text-base !tracking-normal">
                {assistant ? t('editAssistant') : t('newAssistant')}
              </DialogTitle>
              {!creating ? (
                <DialogDescription className="mt-1 !text-xs">{t('boundaryDescription')}</DialogDescription>
              ) : null}
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
            <div className={cx('flex min-h-0 flex-1', creating ? 'flex-col sm:flex-row' : 'overflow-y-auto')}>
              {creating ? (
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
                            aria-current={active ? 'step' : undefined}
                            disabled={index > createStepIndex}
                            onClick={() => {
                              if (done) setCreateStep(step.id);
                            }}
                            className={cx(
                              'flex h-10 min-w-max items-center gap-2 rounded-md px-3 text-sm transition-colors sm:w-full',
                              active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                              'disabled:cursor-default disabled:opacity-55',
                            )}
                          >
                            <span className={cx(
                              'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium',
                              active ? 'bg-foreground text-background' : 'border border-border text-muted-foreground',
                            )}>
                              {index + 1}
                            </span>
                            <span>{step.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </nav>
              ) : null}

              <div className={cx(
                'min-h-0 min-w-0 flex-1 overflow-y-auto',
                !creating && 'space-y-5 px-5 py-4',
              )}>
                <section
                  hidden={creating && createStep !== 'basic'}
                  aria-labelledby={creating ? 'assistant-create-basic-title' : undefined}
                  className={creating ? 'mx-auto max-w-2xl space-y-5 px-5 py-6 sm:px-8' : 'space-y-5'}
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

                  <label className={cx('block text-xs', creating ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')}>
                    {t('name')}
                    <input
                      name="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                      maxLength={100}
                      autoFocus
                      className={cx('ui-input mt-1.5 w-full', creating ? 'h-10' : 'h-9')}
                      placeholder={t('namePlaceholder')}
                    />
                  </label>

                  <div className={cx('block text-xs', creating ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')}>
                    <span>{t('model')}</span>
                    <ModelPicker
                      providers={providers}
                      value={providerId && model ? { providerId, model } : null}
                      onSelect={(selection) => {
                        setProviderId(selection.providerId);
                        setModel(selection.model);
                      }}
                      onConfigure={() => {
                        const returnTo = assistant ? chatHref(slug, assistant.id) : `/app/${encodeURIComponent(slug)}/chat`;
                        window.location.assign(`/app/${encodeURIComponent(slug)}/settings/providers?returnTo=${encodeURIComponent(returnTo)}`);
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
                  hidden={creating && createStep !== 'instructions'}
                  aria-labelledby={creating ? 'assistant-create-instructions-title' : undefined}
                  className={creating ? 'mx-auto max-w-2xl space-y-5 px-5 py-6 sm:px-8' : 'space-y-5'}
                >
                  {creating ? (
                    <div>
                      <h3 id="assistant-create-instructions-title" className="text-base font-semibold text-foreground">{t('systemPrompt')}</h3>
                    </div>
                  ) : null}
                  <label className={cx('block text-xs', creating ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')}>
                    {t('systemPrompt')}
                    <textarea
                      name="systemPrompt"
                      defaultValue={assistant?.systemPrompt ?? marketTemplate?.systemPrompt ?? ''}
                      rows={creating ? 12 : 5}
                      maxLength={20_000}
                      className={cx('ui-input mt-1.5 w-full resize-y py-2', creating ? 'min-h-72' : '!h-28')}
                      placeholder={t('systemPromptPlaceholder')}
                    />
                  </label>
                </section>

                <section
                  hidden={creating && createStep !== 'tools'}
                  aria-labelledby={creating ? 'assistant-create-tools-title' : undefined}
                  className={creating ? 'mx-auto max-w-2xl space-y-5 px-5 py-6 sm:px-8' : 'space-y-5'}
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
                      min={1}
                      max={20}
                      defaultValue={assistant?.maxSteps ?? marketTemplate?.maxSteps ?? 8}
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

                {error ? <p role="alert" className={cx('text-sm text-destructive', creating && 'mx-auto max-w-2xl px-5 sm:px-8')}>{error}</p> : null}
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
                    onClick={(event) => {
                      if (!event.currentTarget.form?.reportValidity()) return;
                      setCreateStep(createSteps[createStepIndex + 1]!.id);
                    }}
                    className="ui-button-primary h-9 gap-2 px-4 text-sm"
                  >
                    {t('next')}
                    <ChevronRight className="size-4" />
                  </button>
                ) : null}
                {creating && lastCreateStep ? (
                  <button type="submit" disabled={saving || !name.trim()} className="ui-button-primary h-9 gap-2 px-4 text-sm">
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
  workspaceId: string;
}) {
  const t = useTranslations('console.chatAssistants');
  const common = useTranslations('common');
  const router = useRouter();
  const activeAssistant = assistants.find((assistant) => assistant.id === selectedAssistantId) ?? assistants[0] ?? null;
  const activeThread = activeAssistant?.threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const [query, setQuery] = useState('');
  const [expandedAssistants, setExpandedAssistants] = useState<Record<string, boolean>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
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

  return (
    <>
      <div className="relative flex h-full min-h-0 overflow-hidden bg-background">
        <div className={cx(
          'grid min-h-0 flex-1 grid-cols-1',
          sidebarOpen && 'lg:grid-cols-[15rem_minmax(0,1fr)]',
          branchOpen && !branchMaximized && (sidebarOpen
            ? 'xl:grid-cols-[15rem_minmax(0,1fr)_20rem]'
            : 'xl:grid-cols-[minmax(0,1fr)_20rem]'),
        )}>
          <aside className={cx(
            'min-h-0 flex-col overflow-hidden bg-background p-1.5',
            mobilePane === 'chat' ? (sidebarOpen ? 'hidden lg:flex' : 'hidden') : (sidebarOpen ? 'flex' : 'flex lg:hidden'),
          )}>
            <div className="relative px-0.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('search')}
                aria-label={t('search')}
                className="h-7 w-full rounded-full border-0 bg-muted/70 pl-7 pr-7 text-[11px] outline-none focus:ring-1 focus:ring-brand/35"
              />
              {query ? (
                <button type="button" onClick={() => setQuery('')} aria-label={common('clear')} className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-background">
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
              <div className="flex h-8 items-center justify-between px-2.5">
                <p className="text-xs font-medium text-muted-foreground">{t('assistants')}</p>
                <button type="button" onClick={() => { setSelectedMarketTemplate(null); setEditing('new'); }} aria-label={t('newAssistant')} title={t('newAssistant')} className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                  <Plus className="size-3.5" />
                </button>
              </div>
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
                          'group flex h-8 items-center rounded-lg',
                          assistant.id === activeAssistant?.id ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60',
                          dropAssistantId === assistant.id && 'ring-1 ring-inset ring-brand/50',
                        )}
                      >
                        <Link href={chatHref(slug, assistant.id)} onClick={() => setMobilePane('chat')} className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[13px]">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground"><Bot className="size-3.5" /></span>
                          <span className="min-w-0 flex-1 truncate">{assistant.name}</span>
                        </Link>
                        <button type="button" onClick={() => setEditing(assistant)} aria-label={`${t('settings')} · ${assistant.name}`} title={t('settings')} className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100 focus:opacity-100">
                          <MoreHorizontal className="size-3.5" />
                        </button>
                        <button type="button" onClick={() => void createThread(assistant.id)} aria-label={t('newChatFor', { name: assistant.name })} title={t('newChat')} className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100 focus:opacity-100">
                          <Plus className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={assistant.name}
                          aria-expanded={expanded}
                          aria-controls={`assistant-chat-threads-${assistant.id}`}
                          title={expanded ? t('hideConversations') : t('showConversations')}
                          onClick={() => setExpandedAssistants((current) => ({ ...current, [assistant.id]: !expanded }))}
                          className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                        >
                          <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
                        </button>
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
                                  'group/thread relative py-0.5',
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
                                    'flex h-8 items-center gap-1.5 rounded-lg px-2 pr-7 text-[13px]',
                                    thread.id === activeThread?.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/75 hover:bg-muted/60',
                                  )}
                                >
                                  <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{thread.title || t('newChat')}</span>
                                </Link>
                                <button
                                  type="button"
                                  onClick={() => void deleteThread(thread.id)}
                                  aria-label={t('deleteThread')}
                                  title={t('deleteThread')}
                                  className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-destructive group-hover/thread:opacity-100 focus:opacity-100"
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
              {!visibleAssistants.length ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('empty')}</p> : null}
            </div>
          </aside>

          <section className={cx(
            'min-h-0 min-w-0 flex-col overflow-hidden bg-background',
            mobilePane === 'sidebar' ? 'hidden lg:flex' : 'flex',
          )}>
            <header className="flex h-11 shrink-0 items-center justify-between gap-3 px-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <button type="button" onClick={() => setMobilePane('sidebar')} aria-label={t('showSidebar')} className="flex size-[30px] items-center justify-center rounded-lg text-muted-foreground hover:bg-muted lg:hidden">
                  <PanelLeftOpen className="size-[18px]" />
                </button>
                <button type="button" onClick={() => setSidebarOpen((value) => !value)} aria-label={sidebarOpen ? t('hideSidebar') : t('showSidebar')} className="hidden size-[30px] items-center justify-center rounded-lg text-muted-foreground hover:bg-muted lg:flex">
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
                        const returnTo = chatHref(slug, activeAssistant.id, activeThread?.id);
                        window.location.assign(`/app/${encodeURIComponent(slug)}/settings/providers?returnTo=${encodeURIComponent(returnTo)}`);
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
            <aside className="hidden min-h-0 overflow-hidden bg-background xl:flex">
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
