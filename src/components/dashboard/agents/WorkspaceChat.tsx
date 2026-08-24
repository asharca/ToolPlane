'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bot,
  ChevronRight,
  Cpu,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import { AgentModelDialog } from '@/components/dashboard/agents/AgentModelDialog';
import { createConversationAction, deleteConversationAction, renameConversationAction } from '@/lib/agents/actions';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';

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
  agentId,
  conversationId,
  initialMessages,
  agents,
  providers = [],
  conversations,
  startInChat = false,
}: {
  slug: string;
  agentId: string;
  conversationId: string | null;
  initialMessages: HermesUIMessage[];
  agents: ChatAgent[];
  providers?: Array<{ id: string; name: string; models: string[] }>;
  conversations: ChatConversation[];
  startInChat?: boolean;
}) {
  const t = useTranslations('console.agents');
  const common = useTranslations('common');
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
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
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
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      <div className={cx(
        'grid min-h-0 flex-1 grid-cols-1',
        sidebarOpen && 'lg:grid-cols-[15rem_minmax(0,1fr)] min-[1024px]:max-[1080px]:grid-cols-[13.125rem_minmax(0,1fr)]!',
      )}>
        <aside
          aria-label={t('agents')}
          className={cx(
            'min-h-0 flex-col overflow-hidden border-r-[0.5px] border-border bg-background p-1.5',
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
          </div>

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
            <div className="flex h-8 items-center justify-between px-2.5">
              <p className="truncate text-xs font-medium text-muted-foreground">{t('agents')}</p>
              <Link
                href={`/app/${encodeURIComponent(slug)}/agents/new`}
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
                      'group flex h-8 min-w-0 items-center rounded-lg transition-colors',
                      agent.id === activeAgent.id ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60 hover:text-foreground',
                    )}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`agent-conversations-${agent.id}`}
                        onClick={() => setExpandedAgents((current) => ({ ...current, [agent.id]: !expanded }))}
                        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-[13px]"
                      >
                        <ChevronRight className={cx('size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Bot className="size-3.5" /></span>
                        <span className={cx('min-w-0 flex-1 truncate', agent.id === activeAgent.id && 'font-medium')}>{agent.name}</span>
                      </button>
                      <span className={cx('mr-1 size-1.5 shrink-0 rounded-full', agent.ready ? 'bg-emerald-500' : 'bg-amber-500')} title={agent.ready ? t('ready1') : t('needsModel')} />
                      <form
                        action={createConversationAction}
                        onSubmit={() => {
                          setExpandedAgents((current) => ({ ...current, [agent.id]: true }));
                          showChatOnNarrow();
                        }}
                        className="mr-1 shrink-0"
                      >
                        <input type="hidden" name="workspace" value={slug} />
                        <input type="hidden" name="agentId" value={agent.id} />
                        <button
                          type="submit"
                          aria-label={newChatLabel}
                          title={newChatLabel}
                          className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-colors hover:bg-background hover:text-foreground group-hover:opacity-100"
                        >
                          <Plus className="size-3.5" />
                        </button>
                      </form>
                    </div>

                    {expanded ? (
                      <div id={`agent-conversations-${agent.id}`} className="ml-4 border-l border-border/60 pl-1">
                        <ul className="py-0.5">
                          {items.map((item) => (
                            <li key={item.id} className="group/conversation relative py-0.5">
                              <Link
                                href={chatHref(slug, agent.id, item.id)}
                                onClick={handleChatNavigation}
                                aria-current={item.id === activeConversationId ? 'page' : undefined}
                                title={item.lastMessageAt ? t('lastMessageOn', { date: item.lastMessageAt }) : t('chatCreatedOn', { date: item.createdAt })}
                                className={cx(
                                  'flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors',
                                  item.editable && 'pr-7',
                                  item.id === activeConversationId ? 'bg-muted font-medium text-foreground' : 'text-foreground/75 hover:bg-muted/60 hover:text-foreground',
                                )}
                              >
                                <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
                                <span className={cx('min-w-0 flex-1 truncate', item.source && 'capitalize')}>{conversationLabel(item, t('newChat'))}</span>
                              </Link>
                              {item.editable ? <details className="absolute right-1 top-1/2 z-10 -translate-y-1/2 opacity-0 group-hover/conversation:opacity-100 focus-within:opacity-100">
                                <summary
                                  aria-label={t('conversationActions', { title: conversationLabel(item, t('newChat')) })}
                                  title={t('conversationActions', { title: conversationLabel(item, t('newChat')) })}
                                  className="flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                                >
                                  <MoreHorizontal className="size-3.5" />
                                </summary>
                                <div className="absolute right-0 top-7 w-60 rounded-lg border border-border bg-popover p-2 shadow-md">
                                  <form action={renameConversationAction} className="flex gap-1">
                                    <input type="hidden" name="workspace" value={slug} />
                                    <input type="hidden" name="agentId" value={agent.id} />
                                    <input type="hidden" name="conversationId" value={item.id} />
                                    <input name="title" defaultValue={item.title ?? ''} aria-label={t('renameConversation')} className="ui-input h-8 min-w-0 flex-1 text-xs" maxLength={120} required />
                                    <button type="submit" className="ui-button-primary h-8 px-2 text-xs">{common('save')}</button>
                                  </form>
                                  <form action={deleteConversationAction} className="mt-1">
                                    <input type="hidden" name="workspace" value={slug} />
                                    <input type="hidden" name="agentId" value={agent.id} />
                                    <input type="hidden" name="conversationId" value={item.id} />
                                    <button type="submit" className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-destructive hover:bg-destructive/10">
                                      <Trash2 className="size-3.5" />
                                      {t('deleteConversation')}
                                    </button>
                                  </form>
                                </div>
                              </details> : null}
                            </li>
                          ))}
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
                <button
                  type="button"
                  onClick={() => setModelDialogOpen(true)}
                  aria-label={t('modelConfiguration')}
                  title={t('modelConfiguration')}
                  className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Cpu className="size-4 shrink-0" />
                  <span className="hidden max-w-52 truncate sm:block">{activeAgent.providerLabel}</span>
                </button>
              </div>
          </header>

          <AgentConversation
            key={`conversation:${agentId}:${conversationId ?? 'new'}`}
            activeConversationId={activeConversationId}
            agentId={activeAgent.id}
            agentName={activeAgent.name}
            creatingConversation={creatingConversation}
            ensureConversation={ensureConversation}
            initialMessages={initialMessages}
            ready={activeAgent.ready}
            runtimeKind={activeAgent.runtimeKind}
          />
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
          />
        </section>
      </div>
    </div>
  );
}
