'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import Link from 'next/link';
import {
  Bot,
  CheckCircle2,
  Clock3,
  MessageSquare,
  Plus,
  Radio,
  Send,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { createConversationAction } from '@/lib/agents/actions';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';

type Conversation = {
  id: string;
  title: string | null;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  source: ParsedMessagingSession | null;
};

type ChannelSummary = {
  id: string;
  platform: string;
  platformLabel: string;
  name: string;
  status: string;
  lastEventAt: string | null;
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
  if (!source) return 'Console chat';
  return `${titleCase(source.platform)} ${source.chatType.toUpperCase()}`;
}

function sourceDetail(source: ParsedMessagingSession | null) {
  if (!source) return 'Started from the ToolPlane console';
  return [source.chatId, source.contextId ? `context ${source.contextId}` : null].filter(Boolean).join(' · ');
}

function channelStatusTone(status: string) {
  if (status === 'running') return 'bg-emerald-500';
  if (status === 'error') return 'bg-red-500';
  if (status === 'setup_required' || status === 'waiting_callback') return 'bg-amber-500';
  return 'bg-muted-foreground';
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
  channels,
  ready,
  agentName,
  providerLabel,
}: {
  slug: string;
  agentId: string;
  conversationId: string | null;
  initialMessages: UIMessage[];
  conversations: Conversation[];
  channels: ChannelSummary[];
  ready: boolean;
  agentName: string;
  providerLabel: string;
}) {
  const t = useTranslations('console.agents');
  const [text, setText] = useState('');
  const { messages, sendMessage, setMessages, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/v1/agents/${agentId}/chat`,
    }),
    messages: initialMessages,
  });

  const busy = status === 'streaming' || status === 'submitted';
  const activeConversation = conversations.find((conversation) => conversation.id === conversationId) ?? null;
  const activeSource = activeConversation?.source ?? null;
  const matchedChannel = activeSource
    ? channels.find((channel) => channel.platform === activeSource.platform) ?? null
    : null;
  const runningChannels = channels.filter((channel) => channel.status === 'running').length;
  const canSend = Boolean(text.trim() && ready && conversationId && !busy);

  const conversationGroups = useMemo(() => {
    const external = conversations.filter((conversation) => conversation.source);
    const consoleChats = conversations.filter((conversation) => !conversation.source);
    return { external, consoleChats };
  }, [conversations]);

  useEffect(() => {
    setMessages(initialMessages);
  }, [conversationId, initialMessages, setMessages]);

  function submitMessage() {
    if (!canSend) return;
    sendMessage({ text }, { body: { conversationId } });
    setText('');
  }

  return (
    <div className="px-8 py-6">
      <div className="grid gap-4 xl:h-[calc(100dvh-17rem)] xl:min-h-[36rem] xl:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="ui-panel flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <form action={createConversationAction}>
              <input type="hidden" name="workspace" value={slug} />
              <input type="hidden" name="agentId" value={agentId} />
              <button className="ui-button-primary h-9 w-full" type="submit">
                <Plus className="size-4" />
                {t('newChat')}
              </button>
            </form>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="border-b border-border px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('channelSessions')}</div>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {conversationGroups.external.length}
                </span>
              </div>
              <ul className="space-y-1">
                {conversationGroups.external.map((conversation) => (
                  <li key={conversation.id}>
                    <Link
                      href={`/app/${slug}/agents/${agentId}?tab=chat&c=${conversation.id}`}
                      className={cx(
                        'block rounded-md px-3 py-2 text-sm transition-colors',
                        conversation.id === conversationId
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{sourceLabel(conversation.source)}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{conversation.messageCount}</span>
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
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('consoleChats')}</div>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {conversationGroups.consoleChats.length}
                </span>
              </div>
              <ul className="space-y-1">
                {conversationGroups.consoleChats.map((conversation) => (
                  <li key={conversation.id}>
                    <Link
                      href={`/app/${slug}/agents/${agentId}?tab=chat&c=${conversation.id}`}
                      className={cx(
                        'block rounded-md px-3 py-2 text-sm transition-colors',
                        conversation.id === conversationId
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{conversation.title ?? `Chat ${conversation.createdAt}`}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{conversation.messageCount}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {conversation.lastMessageAt ? `Last message ${conversation.lastMessageAt}` : t('noMessagesYet')}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section className="px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('connectedChannels')}</div>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {runningChannels}/{channels.length}
                </span>
              </div>
              <ul className="space-y-1">
                {channels.map((channel) => (
                  <li key={channel.id}>
                    <Link
                      href={`/app/${slug}/agents/${agentId}?tab=messaging`}
                      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    >
                      <span className={cx('size-2 rounded-full', channelStatusTone(channel.status))} />
                      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                      <span className="shrink-0 text-[11px]">{channel.platformLabel}</span>
                    </Link>
                  </li>
                ))}
                {channels.length === 0 ? (
                  <li className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                    {t('addTelegramWeixinWecomDiscordOrDingtalkFromChannels')}
                  </li>
                ) : null}
              </ul>
            </section>
          </div>
        </aside>

        <section className="ui-panel flex min-h-[34rem] min-w-0 flex-col overflow-hidden">
          <header className="border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-foreground">{agentName}</h2>
                  <span
                    className={cx(
                      'rounded-md px-2 py-1 text-[11px] font-medium',
                      ready ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {ready ? t('ready2') : t('needsModel')}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{providerLabel}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1 text-muted-foreground">
                  <MessageSquare className="size-3.5" />
                  {messages.length} {t('visible')}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1 text-muted-foreground">
                  <Radio className="size-3.5" />
                  {matchedChannel ? `${matchedChannel.platformLabel} · ${matchedChannel.status}` : sourceLabel(activeSource)}
                </span>
              </div>
            </div>

            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="rounded-md border border-border bg-muted/15 px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  {activeSource ? <Radio className="size-3.5" /> : <TerminalSquare className="size-3.5" />}
                  {sourceLabel(activeSource)}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{sourceDetail(activeSource)}</div>
              </div>
              <div className="rounded-md border border-border bg-muted/15 px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <CheckCircle2 className="size-3.5" />
                  {matchedChannel ? t('matchedChannel') : t('deliveryPath')}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {matchedChannel
                    ? `${matchedChannel.name} · ${matchedChannel.platformLabel} · ${matchedChannel.status}`
                    : activeSource
                      ? t('noActiveChannelRecord')
                      : t('consoleConversation')}
                </div>
              </div>
            </div>
          </header>

          {!ready ? (
            <div className="mx-5 mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {t('pickAProviderAndModelOnSettingsBeforeChatting')}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto bg-muted/10 px-5 py-5">
            {messages.length === 0 ? (
              <div className="flex min-h-full items-center justify-center">
                <div className="max-w-md rounded-md border border-dashed border-border bg-card px-5 py-6 text-center">
                  <Bot className="mx-auto mb-3 size-8 text-muted-foreground" />
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
                        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                          <Bot className="size-4" />
                        </div>
                      ) : null}
                      <div className={cx('min-w-0 max-w-[min(48rem,85%)]', isUser && 'order-first')}>
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
                                <Streamdown
                                  key={index}
                                  plugins={{ code }}
                                  className="space-y-2 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
                                >
                                  {part.text}
                                </Streamdown>
                              );
                            }
                            if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
                              const toolPart = part as { type: string; state?: string; input?: unknown; output?: unknown };
                              return (
                                <div key={index} className="my-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
                                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                                    <Wrench className="size-3.5" />
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
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock3 className="size-4 animate-pulse" />
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

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitMessage();
            }}
            className="border-t border-border bg-card px-4 py-3"
          >
            <div className="flex gap-2">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={conversationId ? t('messageThisAgent') : t('createOrSelectAChatFirst')}
                disabled={!ready || !conversationId || busy}
                rows={1}
                className="ui-input min-h-10 flex-1 resize-none py-2 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!canSend}
                className="ui-button-primary h-10 self-end disabled:opacity-60"
              >
                <Send className="size-4" />
                {t('send')}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
