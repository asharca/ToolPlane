'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ContextMenu } from 'radix-ui';
import { SidebarActionRail } from '@toolplane/ui';
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronRight,
  Cpu,
  Edit3,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import { AgentModelDialog } from '@/components/dashboard/agents/AgentModelDialog';
import type { ModelProviderOption } from '@/components/dashboard/models/ModelPicker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/Dialog';
import {
  createConversationAction,
  deleteConversationAction,
  generateConversationTitleAction,
  renameConversationAction,
} from '@/lib/agents/actions';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';
import type { ReasoningEffort } from '@/lib/agents/constants';

type ChatAgent = {
  id: string;
  name: string;
  providerId?: string | null;
  providerIds?: string[];
  model?: string | null;
  providerLabel: string;
  ready: boolean;
  runtimeKind: string | null;
};

type ChatConversation = {
  id: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  source: ParsedMessagingSession | null;
  editable: boolean;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function chatHref(slug: string, agentId: string, conversationId?: string) {
  const query = new URLSearchParams({ agent: agentId });
  if (conversationId) query.set('c', conversationId);
  return `/app/${encodeURIComponent(slug)}/chat?${query}`;
}

function conversationLabel(item: ChatConversation, fallback: string) {
  return item.source ? `${item.source.platform} · ${item.source.chatId}` : item.title || fallback;
}

export function WorkspaceChat({
  slug,
  workspaceId,
  agentId,
  conversationId,
  initialMessages,
  agents,
  providers = [],
  conversations,
  hermesSelection,
  initialReasoningEffort = 'default',
  reasoningAvailable = false,
  startInChat = false,
}: {
  slug: string;
  workspaceId: string;
  agentId: string;
  conversationId: string | null;
  initialMessages: HermesUIMessage[];
  agents: ChatAgent[];
  providers?: Array<ModelProviderOption & { format: string }>;
  conversations: ChatConversation[];
  hermesSelection?: {
    profile: string;
    provider: string | null;
    model: string | null;
    hasMessages: boolean;
    editable: boolean;
  };
  initialReasoningEffort?: ReasoningEffort;
  reasoningAvailable?: boolean;
  startInChat?: boolean;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
  const router = useRouter();
  const activeAgent = agents.find((agent) => agent.id === agentId) ?? agents[0];
  const [mobilePane, setMobilePane] = useState<'sidebar' | 'chat'>(startInChat ? 'chat' : 'sidebar');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [conversationQuery, setConversationQuery] = useState('');
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const showChatOnNarrow = useCallback(() => setMobilePane('chat'), []);
  const handleChatNavigation = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const nextAgentId = new URL(event.currentTarget.href).searchParams.get('agent');
    if (nextAgentId) {
      setExpandedAgents((current) => current[nextAgentId] ? current : { ...current, [nextAgentId]: true });
    }
    showChatOnNarrow();
  }, [showChatOnNarrow]);
  const [createdConversation, setCreatedConversation] = useState<{
    agentId: string;
    selectedConversationId: string | null;
    id: string;
  } | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [inlineRenameId, setInlineRenameId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ChatConversation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatConversation | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [generatingTitleId, setGeneratingTitleId] = useState<string | null>(null);
  const [titleGenerationFailed, setTitleGenerationFailed] = useState(false);
  const deleteConfirmTimeoutRef = useRef<number | null>(null);
  const generatingTitleRef = useRef(false);
  const selectedConversationIdRef = useRef<string | null>(conversationId);
  const activeConversationIdRef = useRef<string | null>(conversationId);
  const conversationCreationRef = useRef<{
    agentId: string;
    selectedConversationId: string | null;
    promise: Promise<string>;
  } | null>(null);
  const createdConversationId = createdConversation?.agentId === agentId
    && createdConversation.selectedConversationId === conversationId
    ? createdConversation.id
    : null;
  const activeConversationId = createdConversationId ?? conversationId;
  const visibleConversations = useMemo(() => {
    const query = conversationQuery.trim().toLocaleLowerCase();
    return conversations.filter((item) => !query || [
      conversationLabel(item, t('newChat')),
      item.source?.chatType,
      item.source?.contextId,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  }, [conversationQuery, conversations, t]);

  useEffect(() => {
    selectedConversationIdRef.current = conversationId;
    activeConversationIdRef.current = conversationId;
  }, [agentId, conversationId]);

  const clearDeleteConfirmation = useCallback(() => {
    if (deleteConfirmTimeoutRef.current !== null) {
      window.clearTimeout(deleteConfirmTimeoutRef.current);
      deleteConfirmTimeoutRef.current = null;
    }
    setDeleteConfirmId(null);
  }, []);

  useEffect(() => clearDeleteConfirmation, [clearDeleteConfirmation]);

  const generateTitle = useCallback(async (
    targetAgentId: string,
    targetConversationId: string,
    force: boolean,
  ) => {
    if (generatingTitleRef.current) return;
    generatingTitleRef.current = true;
    setGeneratingTitleId(targetConversationId);
    if (force) setTitleGenerationFailed(false);
    const formData = new FormData();
    formData.set('workspace', slug);
    formData.set('agentId', targetAgentId);
    formData.set('conversationId', targetConversationId);
    if (force) formData.set('force', '1');
    try {
      const result = await generateConversationTitleAction(formData);
      if (force && result.error) setTitleGenerationFailed(true);
      else if (!result.error) setTitleGenerationFailed(false);
      router.refresh();
    } catch {
      if (force) setTitleGenerationFailed(true);
      router.refresh();
    } finally {
      generatingTitleRef.current = false;
      setGeneratingTitleId(null);
    }
  }, [router, slug]);

  const handleConversationChanged = useCallback(async () => {
    const currentConversationId = activeConversationIdRef.current;
    if (currentConversationId) await generateTitle(agentId, currentConversationId, false);
    else router.refresh();
  }, [agentId, generateTitle, router]);

  const ensureConversation = useCallback(async (): Promise<string> => {
    if (activeConversationIdRef.current) return activeConversationIdRef.current;

    setCreatingConversation(true);
    const selectedConversationId = selectedConversationIdRef.current;
    const pendingCreation = conversationCreationRef.current;
    if (
      pendingCreation?.agentId === agentId
      && pendingCreation.selectedConversationId === selectedConversationId
    ) {
      return pendingCreation.promise;
    }
    const creation = (async () => {
      const response = await fetch(`/api/v1/agents/${agentId}/conversations`, { method: 'POST' });
      if (!response.ok) throw new Error('conversation');
      const body = await response.json() as { conversationId?: string };
      if (!body.conversationId) throw new Error('conversation');
      const url = new URL(window.location.href);
      if (
        selectedConversationIdRef.current === selectedConversationId
        && url.searchParams.get('agent') === agentId
      ) {
        activeConversationIdRef.current = body.conversationId;
        setCreatedConversation({ agentId, selectedConversationId, id: body.conversationId });
        url.searchParams.set('c', body.conversationId);
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
      return body.conversationId;
    })();
    conversationCreationRef.current = { agentId, selectedConversationId, promise: creation };

    try {
      return await creation;
    } finally {
      if (conversationCreationRef.current?.promise === creation) {
        conversationCreationRef.current = null;
        setCreatingConversation(false);
      }
    }
  }, [agentId]);

  if (!activeAgent) return null;

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden bg-background">
        <div className={cx(
          'grid min-h-0 flex-1 grid-cols-1',
          sidebarOpen && 'lg:grid-cols-[15rem_minmax(0,1fr)] min-[1024px]:max-[1080px]:grid-cols-[13.125rem_minmax(0,1fr)]!',
        )}>
        <aside
          aria-label={t('agents')}
          className={cx(
            'min-h-0 flex-col overflow-hidden bg-background p-1.5',
            mobilePane === 'chat' ? (sidebarOpen ? 'hidden lg:flex' : 'hidden') : (sidebarOpen ? 'flex' : 'flex lg:hidden'),
          )}
        >
          <div className="shrink-0 px-0.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={conversationQuery}
                onChange={(event) => setConversationQuery(event.target.value)}
                placeholder={t('searchConversations')}
                aria-label={t('searchConversations')}
                className="h-7 w-full rounded-full border-0 bg-muted/70 pl-7 pr-7 text-[10px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand/35"
              />
              {conversationQuery ? (
                <button
                  type="button"
                  onClick={() => setConversationQuery('')}
                  aria-label={t('clearConversationSearch')}
                  title={t('clearConversationSearch')}
                  className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
            {titleGenerationFailed ? (
              <p role="alert" className="px-2 pt-1.5 text-[11px] text-destructive">
                {t('generateConversationTitleFailed')}
              </p>
            ) : null}
          </div>

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
            <div className="flex h-8 items-center justify-between px-2.5">
              <p className="truncate text-xs font-medium text-muted-foreground">{t('agents')}</p>
              <Link
                href={`/app/${encodeURIComponent(slug)}/agents?create=1&returnTo=${encodeURIComponent(chatHref(slug, agentId, conversationId ?? undefined))}`}
                aria-label={t('addAgent')}
                title={t('addAgent')}
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-colors hover:bg-muted hover:text-foreground hover:opacity-100"
              >
                <Plus className="size-3.5" />
              </Link>
            </div>
            <ul>
              {agents.map((agent) => {
                const expanded = Boolean(conversationQuery)
                  || (expandedAgents[agent.id] ?? agent.id === activeAgent.id);
                const items = visibleConversations.filter((item) => item.agentId === agent.id);
                const newChatLabel = `${t('newChat')} · ${agent.name}`;

                return (
                  <li key={agent.id} className="py-0.5">
                    <div className={cx(
                      'group flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-1.5 transition-colors',
                      agent.id === activeAgent.id ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground',
                    )}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`agent-conversations-${agent.id}`}
                        title={expanded ? t('hideConversations') : t('showConversations')}
                        onClick={() => setExpandedAgents((current) => ({ ...current, [agent.id]: !expanded }))}
                        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] outline-none"
                      >
                        <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <Bot className="size-3.5" />
                          <span
                            className={cx('absolute right-0 top-0 size-1.5 rounded-full ring-1 ring-background', agent.ready ? 'bg-emerald-500' : 'bg-amber-500')}
                            title={agent.ready ? t('ready1') : t('needsModel')}
                          />
                        </span>
                        <span className={cx('min-w-0 flex-1 truncate', agent.id === activeAgent.id && 'font-medium')}>{agent.name}</span>
                        <span aria-hidden="true" className="-ml-1.5 hidden size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:flex group-has-[:focus-visible]:flex group-has-data-[state=open]:flex">
                          <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
                        </span>
                      </button>
                      <SidebarActionRail hasLeadingSlot revealOnCellFocus>
                        <form
                          action={createConversationAction}
                          onSubmit={() => {
                            setExpandedAgents((current) => ({ ...current, [agent.id]: true }));
                            showChatOnNarrow();
                          }}
                          className="flex shrink-0"
                        >
                          <input type="hidden" name="workspace" value={slug} />
                          <input type="hidden" name="agentId" value={agent.id} />
                          <button
                            type="submit"
                            aria-label={newChatLabel}
                            title={newChatLabel}
                            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </form>
                      </SidebarActionRail>
                    </div>

                    {expanded ? (
                      <div id={`agent-conversations-${agent.id}`} className="ml-4 pl-1">
                        <ul className="py-0.5">
                          {items.length > 0 ? items.map((item) => {
                            const label = conversationLabel(item, t('newChat'));
                            const renaming = inlineRenameId === item.id;
                            const confirmingDelete = deleteConfirmId === item.id;
                            const generatingTitle = generatingTitleId === item.id;
                            const row = (
                              <div className={cx(
                                'group group/conversation relative flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px] leading-5 transition-colors data-[state=open]:bg-muted/60',
                                item.id === activeConversationId
                                  ? 'bg-muted font-medium text-foreground'
                                  : renaming
                                    ? 'bg-muted/60 text-foreground'
                                    : 'text-foreground/75 hover:bg-muted/60 hover:text-foreground',
                              )}>
                                {renaming ? (
                                  <form
                                    action={renameConversationAction}
                                    onSubmit={() => setInlineRenameId(null)}
                                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-5"
                                  >
                                    <input type="hidden" name="workspace" value={slug} />
                                    <input type="hidden" name="agentId" value={agent.id} />
                                    <input type="hidden" name="conversationId" value={item.id} />
                                    <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                                    <input
                                      name="title"
                                      defaultValue={item.title ?? ''}
                                      aria-label={t('renameConversation')}
                                      autoFocus
                                      required
                                      maxLength={120}
                                      onFocus={(event) => event.currentTarget.select()}
                                      onBlur={(event) => {
                                        if (event.currentTarget.value.trim()) event.currentTarget.form?.requestSubmit();
                                        else setInlineRenameId(null);
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key !== 'Escape') return;
                                        event.preventDefault();
                                        setInlineRenameId(null);
                                      }}
                                      className="h-6 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] font-medium leading-5 text-foreground outline-none"
                                    />
                                  </form>
                                ) : (
                                  <Link
                                    href={chatHref(slug, agent.id, item.id)}
                                    onClick={handleChatNavigation}
                                    onDoubleClick={item.editable && !generatingTitle ? (event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setInlineRenameId(item.id);
                                    } : undefined}
                                    aria-current={item.id === activeConversationId ? 'page' : undefined}
                                    title={item.lastMessageAt ? t('lastMessageOn', { date: item.lastMessageAt }) : t('chatCreatedOn', { date: item.createdAt })}
                                    className="flex h-full min-w-0 flex-1 items-center gap-1.5"
                                  >
                                    <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                                    <span className={cx('min-w-0 flex-1 truncate', item.source && 'capitalize', generatingTitle && 'animate-pulse')}>{label}</span>
                                  </Link>
                                )}

                                {item.editable && !renaming ? (
                                  <form
                                    action={deleteConversationAction}
                                    onSubmit={clearDeleteConfirmation}
                                    className={cx(
                                      'absolute right-1 top-1/2 z-10 -translate-y-1/2 transition-opacity duration-150',
                                      confirmingDelete
                                        ? 'pointer-events-auto opacity-100'
                                        : 'pointer-events-none opacity-0 group-focus-within/conversation:pointer-events-auto group-focus-within/conversation:opacity-100 group-hover/conversation:pointer-events-auto group-hover/conversation:opacity-100',
                                    )}
                                  >
                                    <input type="hidden" name="workspace" value={slug} />
                                    <input type="hidden" name="agentId" value={agent.id} />
                                    <input type="hidden" name="conversationId" value={item.id} />
                                    <button
                                      type="submit"
                                      aria-label={confirmingDelete ? common('confirm') : common('delete')}
                                      title={confirmingDelete ? t('deleteConversation') : common('delete')}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        if (event.metaKey || event.ctrlKey || confirmingDelete) {
                                          clearDeleteConfirmation();
                                          return;
                                        }
                                        event.preventDefault();
                                        clearDeleteConfirmation();
                                        setDeleteConfirmId(item.id);
                                        deleteConfirmTimeoutRef.current = window.setTimeout(clearDeleteConfirmation, 2000);
                                      }}
                                      className="flex size-5 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                                    >
                                      {confirmingDelete ? <Trash2 className="size-3.5 text-destructive" /> : <X className="size-3.5" />}
                                    </button>
                                  </form>
                                ) : null}
                              </div>
                            );

                            return (
                              <li key={item.id} className="py-0.5">
                                {item.editable ? (
                                  <ContextMenu.Root modal={false}>
                                    <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
                                    <ContextMenu.Portal>
                                      <ContextMenu.Content className="z-50 max-h-[var(--radix-context-menu-content-available-height)] min-w-32 origin-[var(--radix-context-menu-content-transform-origin)] overflow-x-hidden overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                                        <ContextMenu.Item
                                          disabled={Boolean(generatingTitleId)}
                                          onSelect={() => void generateTitle(agent.id, item.id, true)}
                                          className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                                        >
                                          {generatingTitle ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />}
                                          {t('generateConversationTitle')}
                                        </ContextMenu.Item>
                                        <ContextMenu.Item
                                          disabled={Boolean(generatingTitleId)}
                                          onSelect={() => setRenameTarget(item)}
                                          className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                                        >
                                          <Edit3 className="size-3.5 shrink-0 text-muted-foreground" />
                                          {t('renameConversation')}
                                        </ContextMenu.Item>
                                        <ContextMenu.Separator className="my-1 h-px bg-border" />
                                        <ContextMenu.Item
                                          onSelect={() => setDeleteTarget(item)}
                                          className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                                        >
                                          <Trash2 className="size-3.5 shrink-0 text-destructive" />
                                          {t('deleteConversation')}
                                        </ContextMenu.Item>
                                      </ContextMenu.Content>
                                    </ContextMenu.Portal>
                                  </ContextMenu.Root>
                                ) : row}
                              </li>
                            );
                          }) : !conversationQuery ? (
                            <li className="flex h-8 items-center px-2 text-xs text-muted-foreground">{t('noConversations')}</li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {conversationQuery && visibleConversations.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('noConversationsMatch')}</p>
            ) : null}
          </div>
        </aside>

        <section className={`${mobilePane === 'sidebar' ? 'hidden lg:flex' : 'flex'} min-h-0 min-w-0 flex-col overflow-hidden bg-background`}>
          <header className="flex h-11 shrink-0 items-center justify-between gap-3 bg-background px-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t('showConversations')}
                  title={t('showConversations')}
                  onClick={() => setMobilePane('sidebar')}
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
                >
                  <PanelLeftOpen className="size-[18px]" />
                </button>
                <button
                  type="button"
                  aria-label={sidebarOpen ? t('hideConversations') : t('showConversations')}
                  title={sidebarOpen ? t('hideConversations') : t('showConversations')}
                  aria-pressed={sidebarOpen}
                  onClick={() => setSidebarOpen((open) => !open)}
                  className="hidden size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:flex"
                >
                  {sidebarOpen ? <PanelLeftClose className="size-[18px]" /> : <PanelLeftOpen className="size-[18px]" />}
                </button>
                <span className="ml-0.5 flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-foreground hover:bg-muted">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Bot className="size-3" /></span>
                  <span className="max-w-40 truncate">{activeAgent.name}</span>
                  <span className={cx('size-1.5 shrink-0 rounded-full', activeAgent.ready ? 'bg-emerald-500' : 'bg-amber-500')} title={activeAgent.ready ? t('ready1') : t('needsModel')} />
                </span>
                <AgentModelDialog
                  key={activeAgent.id}
                  open={modelDialogOpen}
                  onOpenChange={setModelDialogOpen}
                  slug={slug}
                  agent={{
                    ...activeAgent,
                    providerId: activeAgent.providerId ?? null,
                    providerIds: activeAgent.providerIds ?? [],
                    model: activeAgent.model ?? null,
                  }}
                  providers={providers}
                  hermesConversation={activeAgent.runtimeKind === 'hermes' ? {
                    id: activeConversationId,
                    profile: hermesSelection?.profile ?? 'default',
                    provider: hermesSelection?.provider ?? null,
                    model: hermesSelection?.model ?? null,
                    hasMessages: hermesSelection?.hasMessages ?? false,
                    editable: hermesSelection?.editable ?? true,
                  } : undefined}
                  trigger={(
                    <button
                      type="button"
                      disabled={conversationBusy}
                      aria-label={t('modelConfiguration')}
                      title={t('modelConfiguration')}
                      className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {activeAgent.runtimeKind === 'hermes' || !activeAgent.model ? (
                        <Cpu className="size-4 shrink-0" />
                      ) : (
                        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[9px] font-semibold text-muted-foreground">
                          {activeAgent.model.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="hidden max-w-52 truncate sm:block">
                        {activeAgent.runtimeKind === 'hermes'
                          ? `${hermesSelection?.profile ?? 'default'} · ${hermesSelection?.model ?? t('profileDefault')}`
                          : activeAgent.model ?? t('select')}
                      </span>
                      <ChevronDown className="size-3.5 shrink-0" />
                    </button>
                  )}
                />
              </div>
          </header>

          <AgentConversation
            key={`conversation:${agentId}:${conversationId ?? 'new'}`}
            activeConversationId={activeConversationId}
            agentId={activeAgent.id}
            agentName={activeAgent.name}
            attachmentUploadUrl={activeAgent.runtimeKind === 'hermes'
              ? undefined
              : `/api/v1/workspaces/${workspaceId}/attachments`}
            creatingConversation={creatingConversation}
            ensureConversation={ensureConversation}
            initialMessages={initialMessages}
            initialReasoningEffort={initialReasoningEffort}
            mcpPromptApiPath={`/api/v1/agents/${activeAgent.id}/prompts`}
            onBusyChange={setConversationBusy}
            ready={activeAgent.ready}
            reasoningAvailable={reasoningAvailable}
            runtimeKind={activeAgent.runtimeKind}
            onConversationChanged={handleConversationChanged}
          />
        </section>
        </div>
      </div>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          {renameTarget ? (
            <DialogContent
              key={renameTarget.id}
              aria-describedby={undefined}
              onInteractOutside={(event) => event.preventDefault()}
              className="!z-[51] !max-w-md !gap-0 !overflow-hidden !rounded-2xl !border-border !p-0"
            >
              <header className="border-b border-border px-4 py-3">
                <DialogTitle className="!text-sm !leading-4 !tracking-normal">{t('renameConversation')}</DialogTitle>
              </header>
              <form action={renameConversationAction} onSubmit={() => setRenameTarget(null)} className="flex flex-col">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="agentId" value={renameTarget.agentId} />
                <input type="hidden" name="conversationId" value={renameTarget.id} />
                <label className="space-y-1 px-4 py-3 text-xs font-medium text-muted-foreground">
                  {t('name')}
                  <input
                    name="title"
                    defaultValue={renameTarget.title ?? ''}
                    placeholder={t('newChat')}
                    autoFocus
                    required
                    maxLength={120}
                    className="ui-input mt-1 h-8 w-full rounded-lg px-2.5 text-sm text-foreground"
                  />
                </label>
                <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
                  <button type="button" onClick={() => setRenameTarget(null)} className="ui-button-secondary h-8 min-h-8 rounded-lg px-3 text-xs">{common('cancel')}</button>
                  <button type="submit" className="ui-button-primary h-8 min-h-8 rounded-lg px-3 text-xs">{common('save')}</button>
                </footer>
              </form>
            </DialogContent>
          ) : null}
        </DialogPortal>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogPortal>
          <DialogOverlay className="!bg-black/40" />
          {deleteTarget ? (
            <DialogContent key={deleteTarget.id} className="!z-[51] !max-w-lg !gap-5 !rounded-3xl !border-0 !p-6">
              <form action={deleteConversationAction} onSubmit={() => setDeleteTarget(null)}>
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="agentId" value={deleteTarget.agentId} />
                <input type="hidden" name="conversationId" value={deleteTarget.id} />
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 size-5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="!text-base !leading-6 !tracking-normal">{t('deleteConversation')}</DialogTitle>
                    <DialogDescription className="mt-2 !leading-5">{t('deleteConversationDescription')}</DialogDescription>
                  </div>
                </div>
                <footer className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setDeleteTarget(null)} className="ui-button-secondary h-9 px-4 text-sm">{common('cancel')}</button>
                  <button type="submit" className="ui-button-primary ui-button-danger h-9 px-4 text-sm">{common('delete')}</button>
                </footer>
              </form>
            </DialogContent>
          ) : null}
        </DialogPortal>
      </Dialog>
    </>
  );
}
