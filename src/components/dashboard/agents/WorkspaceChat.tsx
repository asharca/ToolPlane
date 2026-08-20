'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bot,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import { createConversationAction } from '@/lib/agents/actions';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';

type ChatAgent = {
  id: string;
  name: string;
  providerLabel: string;
  ready: boolean;
  runtimeKind: string | null;
};

type Conversation = {
  id: string;
  title: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  source: ParsedMessagingSession | null;
};

const NARROW_VIEWPORT_QUERY = '(max-width: 1023px)';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function subscribeToNarrowViewport(onChange: () => void) {
  const media = window.matchMedia?.(NARROW_VIEWPORT_QUERY);
  if (!media) return () => undefined;
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getNarrowViewportSnapshot() {
  return window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches ?? false;
}

function chatHref(slug: string, agentId: string, conversationId?: string) {
  const query = new URLSearchParams({ agent: agentId });
  if (conversationId) query.set('c', conversationId);
  return `/app/${encodeURIComponent(slug)}/chat?${query}`;
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sourceLabel(source: ParsedMessagingSession | null) {
  return source ? `${titleCase(source.platform)} ${source.chatType.toUpperCase()}` : null;
}

export function WorkspaceChat({
  slug,
  agentId,
  conversationId,
  initialMessages,
  agents,
  conversations,
}: {
  slug: string;
  agentId: string;
  conversationId: string | null;
  initialMessages: HermesUIMessage[];
  agents: ChatAgent[];
  conversations: Conversation[];
}) {
  const t = useTranslations('console.agents');
  const activeAgent = agents.find((agent) => agent.id === agentId) ?? agents[0];
  const narrowViewport = useSyncExternalStore(
    subscribeToNarrowViewport,
    getNarrowViewportSnapshot,
    () => false,
  );
  const viewportMode = narrowViewport ? 'narrow' : 'wide';
  const [sidebarOverrides, setSidebarOverrides] = useState<Partial<Record<'narrow' | 'wide', boolean>>>({});
  const sidebarCollapsed = sidebarOverrides[viewportMode] ?? narrowViewport;
  const showConversationPane = !sidebarCollapsed;
  const showChat = sidebarCollapsed || !narrowViewport;
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarOverrides((current) => ({ ...current, [viewportMode]: collapsed }));
  }, [viewportMode]);
  const [createdConversation, setCreatedConversation] = useState<{
    agentId: string;
    selectedConversationId: string | null;
    id: string;
  } | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [conversationQuery, setConversationQuery] = useState('');
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

  const conversationItems = useMemo(() => conversations.map((conversation) => ({
    ...conversation,
    label: sourceLabel(conversation.source) ?? conversation.title ?? t('chatCreatedOn', { date: conversation.createdAt }),
    detail: conversation.source?.chatId ?? conversation.lastMessageAt ?? t('noMessagesYet'),
  })), [conversations, t]);
  const visibleConversationItems = useMemo(() => {
    const query = conversationQuery.trim().toLowerCase();
    if (!query) return conversationItems;
    return conversationItems.filter((conversation) => [conversation.label, conversation.detail]
      .join(' ')
      .toLowerCase()
      .includes(query));
  }, [conversationItems, conversationQuery]);

  if (!activeAgent) return null;

  return (
    <div className="flex h-[calc(100dvh-7.5rem-1px)] min-h-0 bg-background lg:h-[calc(100dvh-4rem-1px)]">
      <div className={cx(
        'grid min-h-0 flex-1',
        sidebarCollapsed ? 'grid-cols-1' : 'lg:grid-cols-[17rem_minmax(0,1fr)]',
      )}>
        {showConversationPane ? (
          <aside aria-label={t('conversations')} className="flex min-h-0 flex-col overflow-hidden border-r border-border bg-muted/10">
            <div className="border-b border-border bg-background p-3">
              <div className="flex gap-2">
                <form action={createConversationAction} className="min-w-0 flex-1">
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="agentId" value={activeAgent.id} />
                  <button type="submit" className="ui-button-secondary h-10 w-full gap-2">
                    <Plus className="size-[18px] shrink-0" />
                    {t('newChat')}
                  </button>
                </form>
                <button
                  type="button"
                  aria-label={t('hideConversations')}
                  title={t('hideConversations')}
                  onClick={() => setSidebarCollapsed(true)}
                  className="ui-button-ghost h-10 w-10 shrink-0 px-0"
                >
                  <PanelLeftClose className="size-5" />
                </button>
              </div>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={conversationQuery}
                  onChange={(event) => setConversationQuery(event.target.value)}
                  placeholder={t('searchConversations')}
                  aria-label={t('searchConversations')}
                  className="ui-input h-9 w-full pl-8 pr-8 text-sm"
                />
                {conversationQuery ? (
                  <button
                    type="button"
                    aria-label={t('clearConversationSearch')}
                    title={t('clearConversationSearch')}
                    onClick={() => setConversationQuery('')}
                    className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <section className="border-b border-border px-3 py-3">
                <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] font-medium text-muted-foreground">
                  <MessageCircle className="size-4 shrink-0" />
                  {t('conversations')}
                </div>
                <ul className="space-y-1">
                  {visibleConversationItems.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        href={chatHref(slug, activeAgent.id, conversation.id)}
                        aria-current={conversation.id === activeConversationId ? 'page' : undefined}
                        className={cx(
                          'block rounded-lg px-2.5 py-2 text-[13px] transition-colors',
                          conversation.id === activeConversationId
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                        )}
                      >
                        <span className="block truncate">{conversation.label}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{conversation.detail}</span>
                      </Link>
                    </li>
                  ))}
                  {visibleConversationItems.length === 0 ? (
                    <li className="px-2.5 py-2 text-xs text-muted-foreground">
                      {conversationQuery ? t('noConversationsMatch') : t('noMessagesYet')}
                    </li>
                  ) : null}
                </ul>
              </section>

              <section className="px-3 py-3">
                <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] font-medium text-muted-foreground">
                  <Bot className="size-4 shrink-0" />
                  {t('agents')}
                </div>
                <ul className="space-y-1">
                  {agents.map((agent) => (
                    <li key={agent.id}>
                      <Link
                        href={chatHref(slug, agent.id)}
                        aria-current={agent.id === activeAgent.id && !activeConversationId ? 'page' : undefined}
                        className={cx(
                          'block rounded-lg px-2.5 py-2 text-[13px] transition-colors',
                          agent.id === activeAgent.id
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                        )}
                      >
                        <span className="flex items-center gap-2 truncate">
                          <span className={cx('size-1.5 shrink-0 rounded-full', agent.ready ? 'bg-emerald-500' : 'bg-amber-500')} />
                          <span className="truncate">{agent.name}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </aside>
        ) : null}

        {showChat ? (
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <header className="shrink-0 border-b border-border bg-background px-4 py-3 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {sidebarCollapsed ? (
                  <button
                    type="button"
                    aria-label={t('showConversations')}
                    title={t('showConversations')}
                    onClick={() => setSidebarCollapsed(false)}
                    className="ui-button-ghost h-10 w-10 shrink-0 px-0"
                  >
                    <PanelLeftOpen className="size-5" />
                  </button>
                ) : null}
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Bot className="size-[18px]" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-foreground">{activeAgent.name}</h2>
                    <span className={cx(
                      'inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11px] font-medium',
                      activeAgent.ready ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                    )}>
                      {activeAgent.ready ? t('ready1') : t('needsModel')}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{activeAgent.providerLabel}</p>
                </div>
              </div>
              <Link
                href={`/app/${encodeURIComponent(slug)}/agents/${activeAgent.id}`}
                aria-label={t('settings')}
                title={t('settings')}
                className="ui-button-ghost ui-icon-button shrink-0"
              >
                <Settings2 className="size-[18px]" />
              </Link>
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
        </section>
        ) : null}
      </div>
    </div>
  );
}
