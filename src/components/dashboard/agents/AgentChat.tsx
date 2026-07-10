'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import Link from 'next/link';
import {
  Bot,
  Clock3,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  Route,
  Send,
  Settings2,
  Wrench,
  X,
} from 'lucide-react';
import { code } from '@streamdown/code';
import { createConversationAction } from '@/lib/agents/actions';
import { AgentSettingsForm } from '@/components/dashboard/agents/AgentSettingsForm';
import { AgentMessagingPanel } from '@/components/dashboard/agents/AgentMessagingPanel';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';
import type { AgentChannelConnectionView } from '@/lib/agents/channel-connections';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';

type Conversation = {
  id: string;
  title: string | null;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  source: ParsedMessagingSession | null;
};

type SettingsData = {
  name: string;
  systemPrompt: string;
  providerId: string | null;
  model: string | null;
  maxSteps: number;
  providers: Array<{ id: string; name: string; models: string[] }>;
  deployments: Array<{ id: string; label: string; checked: boolean; running?: boolean }>;
  skills: Array<{ id: string; label: string; checked: boolean; running?: boolean }>;
  toolkits: Array<{ id: string; label: string; checked: boolean; running?: boolean }>;
  sandboxes: Array<{ id: string; label: string; checked: boolean; running?: boolean }>;
  subAgents: Array<{ id: string; label: string; checked: boolean; running?: boolean }>;
};

type ChannelSettingsData = {
  endpoint: string;
  connections: Array<AgentChannelConnectionView & { callbackUrl: string }>;
  stats: {
    mcp: number;
    skills: number;
    toolkits: number;
    sandboxes: number;
    subAgents: number;
  };
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sourceLabel(source: ParsedMessagingSession | null) {
  if (!source) return 'Chat';
  return `${titleCase(source.platform)} ${source.chatType.toUpperCase()}`;
}

function sourceDetail(source: ParsedMessagingSession | null) {
  if (!source) return 'ToolPlane';
  return [source.chatId, source.contextId ? `context ${source.contextId}` : null].filter(Boolean).join(' · ');
}

function displayUserText(text: string) {
  return text.replace(/^\[Messaging source:[^\]]+\]\n\n/, '').trim() || text;
}

export function AgentChat({
  slug,
  agentId,
  conversationId,
  initialMessages,
  conversations,
  settings,
  channelSettings,
  ready,
  agentName,
  providerLabel,
  initialSettingsTab,
}: {
  slug: string;
  agentId: string;
  conversationId: string | null;
  initialMessages: UIMessage[];
  conversations: Conversation[];
  settings: SettingsData;
  channelSettings: ChannelSettingsData;
  ready: boolean;
  agentName: string;
  providerLabel: string;
  initialSettingsTab?: 'agent' | 'channels' | null;
}) {
  const t = useTranslations('console.agents');
  const [text, setText] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initialSettingsTab));
  const [settingsTab, setSettingsTab] = useState<'agent' | 'channels'>(initialSettingsTab ?? 'agent');
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { messages, sendMessage, setMessages, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/v1/agents/${agentId}/chat`,
    }),
    messages: initialMessages,
  });

  const busy = status === 'streaming' || status === 'submitted';
  const sending = busy || creatingConversation;
  const canSend = Boolean(text.trim() && ready && !sending);
  const activeConversationId = createdConversationId ?? conversationId;

  const conversationGroups = useMemo(() => {
    const external = conversations.filter((conversation) => conversation.source);
    const consoleChats = conversations.filter((conversation) => !conversation.source);
    return { external, consoleChats };
  }, [conversations]);

  useEffect(() => {
    setMessages(initialMessages);
  }, [conversationId, initialMessages, setMessages]);

  async function ensureConversation() {
    if (activeConversationId) return activeConversationId;

    setCreatingConversation(true);
    try {
      const response = await fetch(`/api/v1/agents/${agentId}/conversations`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('conversation');
      const body = await response.json() as { conversationId?: string };
      if (!body.conversationId) throw new Error('conversation');
      setCreatedConversationId(body.conversationId);
      return body.conversationId;
    } finally {
      setCreatingConversation(false);
    }
  }

  async function submitMessage() {
    if (!canSend) return;
    const nextText = text;
    setSubmitError(null);
    try {
      const activeConversationId = await ensureConversation();
      sendMessage({ text: nextText }, { body: { conversationId: activeConversationId } });
      setText('');
    } catch {
      setSubmitError(t('couldNotCreateConversation'));
    }
  }

  return (
    <div className="box-border flex h-[calc(100dvh-3.5rem)] min-h-0 p-3 sm:p-4 lg:h-dvh lg:p-3">
      <div
        className={cx(
          'grid min-h-0 flex-1 gap-3',
          sidebarCollapsed ? 'xl:grid-cols-1' : 'xl:grid-cols-[14rem_minmax(0,1fr)]',
        )}
      >
        {!sidebarCollapsed ? (
        <aside className="ui-panel flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <form action={createConversationAction} className="min-w-0 flex-1">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="agentId" value={agentId} />
                <button className="ui-button-primary h-10 w-full gap-2" type="submit">
                  <Plus className="size-[18px] shrink-0" />
                  {t('newChat')}
                </button>
              </form>
              <button
                type="button"
                aria-label={t('hideConversations')}
                title={t('hideConversations')}
                onClick={() => setSidebarCollapsed(true)}
                className="ui-button-secondary h-11 w-11 shrink-0 px-0"
              >
                <PanelLeftClose className="size-5" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="border-b border-border px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Radio className="size-4 shrink-0" />
                  {t('channels')}
                </div>
              </div>
              <ul className="space-y-1">
                {conversationGroups.external.map((conversation) => (
                  <li key={conversation.id}>
                    <Link
                      href={`/app/${slug}/agents/${agentId}?c=${conversation.id}`}
                      className={cx(
                        'block rounded-md px-3 py-2.5 text-sm transition-colors',
                        conversation.id === activeConversationId
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{sourceLabel(conversation.source)}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {sourceDetail(conversation.source)}
                      </div>
                    </Link>
                  </li>
                ))}
                {conversationGroups.external.length === 0 ? (
                  <li className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                    {t('connectedChannelsWillAppearHereAfterTheirFirstMessage')}
                  </li>
                ) : null}
              </ul>
            </section>

            <section className="border-b border-border px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <MessageCircle className="size-4 shrink-0" />
                  {t('conversations')}
                </div>
              </div>
              <ul className="space-y-1">
                {conversationGroups.consoleChats.map((conversation) => (
                  <li key={conversation.id}>
                    <Link
                      href={`/app/${slug}/agents/${agentId}?c=${conversation.id}`}
                      className={cx(
                        'block rounded-md px-3 py-2.5 text-sm transition-colors',
                        conversation.id === activeConversationId
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{conversation.title ?? `Chat ${conversation.createdAt}`}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {conversation.lastMessageAt ? `Last message ${conversation.lastMessageAt}` : t('noMessagesYet')}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

          </div>
        </aside>
        ) : null}

        <section className="ui-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
          <header className="shrink-0 border-b border-border px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                {sidebarCollapsed ? (
                  <button
                    type="button"
                    aria-label={t('showConversations')}
                    title={t('showConversations')}
                    onClick={() => setSidebarCollapsed(false)}
                    className="ui-button-secondary h-11 w-11 shrink-0 px-0"
                  >
                    <PanelLeftOpen className="size-5" />
                  </button>
                ) : null}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="truncate text-base font-semibold text-foreground">{agentName}</h2>
                    <span
                      className={cx(
                        'inline-flex h-6 items-center rounded-md px-2.5 text-xs font-medium',
                        ready ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                      )}
                    >
                      {ready ? t('ready2') : t('needsModel')}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{providerLabel}</p>
                </div>
              </div>
              <button
                type="button"
                aria-label={t('settings')}
                title={t('settings')}
                onClick={() => {
                  setSettingsTab('agent');
                  setSettingsOpen(true);
                }}
                className="ui-button-secondary h-10 shrink-0 gap-2 px-4"
              >
                <Settings2 className="size-[18px] shrink-0" />
                {t('settings')}
              </button>
            </div>
          </header>

          {!ready ? (
            <div className="mx-5 mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {t('pickAProviderAndModelOnSettingsBeforeChatting')}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-5 sm:px-5">
            {messages.length === 0 ? (
              <div className="flex min-h-full items-center justify-center">
                <div className="max-w-md px-5 py-6 text-center">
                  <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                    <MessageCircle className="size-6" />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">{t('startAConversation')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('sendAConsoleMessageHereOrLetAConnectedChannelCreateItsOwnSessionAfterTheFirstInboundMessage')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {messages.map((message) => {
                  const isUser = message.role === 'user';
                  return (
                    <article key={message.id} className={cx('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
                      {!isUser ? (
                        <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                          <Bot className="size-[18px]" />
                        </div>
                      ) : null}
                      <div className={cx('min-w-0 max-w-[min(72rem,94%)]', isUser && 'order-first')}>
                        <div className={cx('mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground', isUser && 'text-right')}>
                          {isUser ? t('user') : agentName}
                        </div>
                        <div
                          className={cx(
                            'min-w-0 break-words rounded-md border px-3 py-2 text-sm leading-relaxed',
                            isUser
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-card text-foreground',
                          )}
                        >
                          {message.parts.map((part, index) => {
                            if (part.type === 'text') {
                              if (isUser) {
                                return (
                                  <span key={index} className="whitespace-pre-wrap">
                                    {displayUserText(part.text)}
                                  </span>
                                );
                              }
                              return (
                                <SafeStreamdown
                                  key={index}
                                  plugins={{ code }}
                                  className="space-y-2 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
                                >
                                  {part.text}
                                </SafeStreamdown>
                              );
                            }
                            if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                              const toolPart = part as { type: string; state?: string; input?: unknown; output?: unknown };
                              return (
                                <div key={index} className="my-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
                                  <div className="flex items-center gap-2 font-medium text-foreground">
                                    <Wrench className="size-4 shrink-0" />
                                    {toolPart.type.replace(/^tool-/, '')} {toolPart.state ? `(${toolPart.state})` : ''}
                                  </div>
                                  {toolPart.output !== undefined ? (
                                    <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-background p-2 text-[11px] leading-relaxed">
                                      {JSON.stringify(toolPart.output, null, 2)}
                                    </pre>
                                  ) : null}
                                </div>
                              );
                            }
                            return null;
                          })}
                        </div>
                      </div>
                    </article>
                  );
                })}
                {busy ? (
                  <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <Clock3 className="size-[18px] shrink-0 animate-pulse" />
                    {t('agentIsResponding')}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {error ? (
            <p
              role="alert"
              className="mx-5 mt-3 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
            >
              {error.message}
            </p>
          ) : null}

          {submitError ? (
            <p
              role="alert"
              className="mx-5 mt-3 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
            >
              {submitError}
            </p>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitMessage();
            }}
            className="shrink-0 border-t border-border bg-card px-4 py-4"
          >
            <div className="rounded-md border border-input bg-background p-2 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t('messageThisAgent')}
                disabled={sending}
                rows={3}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitMessage();
                  }
                }}
                className="min-h-24 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
              />
              <div className="flex items-center justify-between gap-3 border-t border-border/70 px-2 pt-2">
                <div className="min-w-0 text-xs text-muted-foreground">
                  {!ready ? t('chooseAModelBeforeSending') : activeConversationId ? t('conversationSelected') : t('conversationWillBeCreated')}
                </div>
              <button
                type="submit"
                disabled={!canSend}
                aria-label={t('send')}
                title={t('send')}
                className="ui-button-primary h-10 gap-2 px-4 disabled:opacity-60"
              >
                  <Send className="size-[18px] shrink-0" />
                  {creatingConversation ? t('creating') : t('send')}
              </button>
              </div>
            </div>
          </form>
        </section>
      </div>

      {settingsOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-end bg-background/70 p-3 backdrop-blur-sm sm:p-5">
          <section className="ui-panel flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden shadow-xl">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2.5 truncate text-sm font-semibold text-foreground">
                  <Settings2 className="size-[18px] shrink-0 text-muted-foreground" />
                  {t('settings')}
                </h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{agentName}</p>
              </div>
              <button
                type="button"
                aria-label={t('closeSettings')}
                title={t('closeSettings')}
                onClick={() => setSettingsOpen(false)}
                className="ui-button-secondary h-11 w-11 shrink-0 px-0"
              >
                <X className="size-5" />
              </button>
            </header>
            <div className="flex shrink-0 gap-2 border-b border-border px-5 py-3">
              <button
                type="button"
                onClick={() => setSettingsTab('agent')}
                className={cx(
                  'inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors',
                  settingsTab === 'agent'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Settings2 className="size-4 shrink-0" />
                {t('agentSettingsTab')}
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab('channels')}
                className={cx(
                  'inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors',
                  settingsTab === 'channels'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Route className="size-4 shrink-0" />
                {t('channelSettingsTab')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {settingsTab === 'agent' ? (
                <AgentSettingsForm
                  slug={slug}
                  agentId={agentId}
                  name={settings.name}
                  systemPrompt={settings.systemPrompt}
                  providerId={settings.providerId}
                  model={settings.model}
                  maxSteps={settings.maxSteps}
                  providers={settings.providers}
                  deployments={settings.deployments}
                  skills={settings.skills}
                  toolkits={settings.toolkits}
                  sandboxes={settings.sandboxes}
                  subAgents={settings.subAgents}
                  className="space-y-4 px-5 py-5"
                />
              ) : (
                <AgentMessagingPanel
                  slug={slug}
                  agentId={agentId}
                  endpoint={channelSettings.endpoint}
                  connections={channelSettings.connections}
                  ready={ready}
                  stats={channelSettings.stats}
                />
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
