'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type FileUIPart } from 'ai';
import dynamic from 'next/dynamic';
import type { AgentResourceOption } from '@/components/dashboard/agents/AgentResourceSelect';
import Link from 'next/link';
import {
  Bot,
  Clock3,
  Container,
  MessageCircle,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  Route,
  Send,
  Settings2,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { code } from '@streamdown/code';
import { createConversationAction } from '@/lib/agents/actions';
import { SafeStreamdown } from '@/components/dashboard/SafeStreamdown';
import type { AgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import { HERMES_EMBED_CLOSE_MESSAGE } from '@/lib/agents/hermes/embed-message';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';
import {
  expandHermesAssistantMessages,
  type HermesUIMessage,
} from '@/lib/agents/hermes/message-segments';

const AgentSettingsForm = dynamic(() =>
  import('@/components/dashboard/agents/AgentSettingsForm').then(
    (module) => module.AgentSettingsForm,
  ),
);

const AgentMessagingPanel = dynamic(() =>
  import('@/components/dashboard/agents/AgentMessagingPanel').then(
    (module) => module.AgentMessagingPanel,
  ),
);

const HermesRuntimePanel = dynamic(() =>
  import('@/components/dashboard/agents/HermesRuntimePanel').then(
    (module) => module.HermesRuntimePanel,
  ),
);

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
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  toolkits: AgentResourceOption[];
  sandboxes: AgentResourceOption[];
  subAgents: AgentResourceOption[];
  runtime?: {
    kind: string;
    image: string;
    status: string;
    lastError: string | null;
    lastSyncedAt: string | null;
    sandboxId: string;
    deploymentId: string;
    dashboardUrl: string;
  } | null;
};

type ChannelSettingsData = {
  connections: AgentChannelConnectionClientView[];
};

const FOCUSABLE_SETTINGS_ELEMENTS = [
  'a[href]',
  'button:not([disabled])',
  'iframe',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

function fileToUIPart(file: File): Promise<FileUIPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve({
      type: 'file',
      mediaType: file.type || 'application/octet-stream',
      filename: file.name,
      url: String(reader.result ?? ''),
    });
    reader.readAsDataURL(file);
  });
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
  initialMessages: HermesUIMessage[];
  conversations: Conversation[];
  settings: SettingsData;
  channelSettings: ChannelSettingsData;
  ready: boolean;
  agentName: string;
  providerLabel: string;
  initialSettingsTab?: 'agent' | 'channels' | 'hermes' | 'terminal' | null;
}) {
  const t = useTranslations('console.agents');
  const supportsChannelSettings = settings.runtime?.kind !== 'hermes';
  const requestedSettingsTab = initialSettingsTab ?? 'agent';
  const initialTab = !supportsChannelSettings && requestedSettingsTab === 'channels'
    ? 'agent'
    : requestedSettingsTab;
  const [text, setText] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initialSettingsTab));
  const [settingsTab, setSettingsTab] = useState<'agent' | 'channels' | 'hermes' | 'terminal'>(initialTab);
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const settingsTitleId = useId();
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsCloseButtonRef = useRef<HTMLButtonElement>(null);
  const settingsDialogRef = useRef<HTMLElement>(null);
  const hermesIframeRef = useRef<HTMLIFrameElement>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    window.setTimeout(() => settingsButtonRef.current?.focus(), 0);
  }, []);
  const { messages, sendMessage, setMessages, status, error } = useChat<HermesUIMessage>({
    transport: new DefaultChatTransport({
      api: `/api/v1/agents/${agentId}/chat`,
    }),
    messages: initialMessages,
  });

  const busy = status === 'streaming' || status === 'submitted';
  const sending = busy || creatingConversation || uploadingAttachments;
  const canSend = Boolean((text.trim() || attachments.length) && ready && !sending);
  const activeConversationId = createdConversationId ?? conversationId;
  const displayMessages = useMemo(() => expandHermesAssistantMessages(messages), [messages]);

  const conversationGroups = useMemo(() => {
    const external = conversations.filter((conversation) => conversation.source);
    const consoleChats = conversations.filter((conversation) => !conversation.source);
    return { external, consoleChats };
  }, [conversations]);

  useEffect(() => {
    setMessages(initialMessages);
  }, [conversationId, initialMessages, setMessages]);

  useEffect(() => {
    if (!settingsOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => settingsCloseButtonRef.current?.focus(), 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSettings();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = settingsDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SETTINGS_ELEMENTS),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function handleMessage(event: MessageEvent) {
      if (
        event.data === HERMES_EMBED_CLOSE_MESSAGE
        && event.source === hermesIframeRef.current?.contentWindow
      ) {
        closeSettings();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('message', handleMessage);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('message', handleMessage);
    };
  }, [closeSettings, settingsOpen]);

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
      let messageText = nextText;
      let fileParts: FileUIPart[] = [];
      if (attachments.length) {
        setUploadingAttachments(true);
        if (settings.runtime?.kind === 'hermes') {
          const uploaded: Array<{ name: string; runtimePath: string }> = [];
          for (const file of attachments) {
            const body = new FormData();
            body.set('conversationId', activeConversationId);
            body.set('file', file);
            const response = await fetch(`/api/v1/agents/${agentId}/attachments`, { method: 'POST', body });
            const result = await response.json().catch(() => ({})) as { name?: string; runtimePath?: string; error?: string };
            if (!response.ok || !result.runtimePath) throw new Error(result.error || t('attachmentUploadFailed'));
            uploaded.push({ name: result.name || file.name, runtimePath: result.runtimePath });
          }
          const attachmentContext = [
            'Uploaded attachments in the Hermes workspace:',
            ...uploaded.map((file) => `- ${file.name}: ${file.runtimePath}`),
          ].join('\n');
          messageText = [nextText, attachmentContext].filter(Boolean).join('\n\n');
          fileParts = await Promise.all(
            attachments
              .filter((file) => file.type.startsWith('image/') && file.size <= 5_000_000)
              .map(fileToUIPart),
          );
        } else {
          fileParts = await Promise.all(attachments.map(fileToUIPart));
        }
      }
      void sendMessage(
        { text: messageText || t('attachedFiles'), ...(fileParts.length ? { files: fileParts } : {}) },
        { body: { conversationId: activeConversationId } },
      );
      setText('');
      setAttachments([]);
    } catch (error) {
      setSubmitError(error instanceof Error && error.message !== 'conversation'
        ? error.message
        : t('couldNotCreateConversation'));
    } finally {
      setUploadingAttachments(false);
    }
  }

  return (
    <div className="box-border flex h-[calc(100dvh-7.5rem-1px)] min-h-0 p-3 sm:p-4 lg:h-[calc(100dvh-4rem-1px)] lg:p-3">
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
                ref={settingsButtonRef}
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
            {displayMessages.length === 0 ? (
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
                {displayMessages.map((message) => {
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
                            if (part.type === 'file') {
                              return (
                                <a
                                  key={index}
                                  href={part.url}
                                  download={part.filename}
                                  className="my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-current/20 px-2 py-1 text-xs underline-offset-2 hover:underline"
                                >
                                  <Paperclip className="size-3.5 shrink-0" />
                                  <span className="truncate">{part.filename || t('attachment')}</span>
                                </a>
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
              {attachments.length ? (
                <div className="flex flex-wrap gap-2 border-b border-border/70 px-2 pb-2">
                  {attachments.map((file, index) => (
                    <span key={`${file.name}-${index}`} className="inline-flex h-8 max-w-full items-center gap-2 rounded-md bg-muted px-2 text-xs text-foreground">
                      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="max-w-48 truncate">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        aria-label={t('removeAttachment', { name: file.name })}
                        title={t('removeAttachment', { name: file.name })}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
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
                <div className="flex min-w-0 items-center gap-2">
                  <label
                    className="ui-button-secondary flex size-10 shrink-0 cursor-pointer items-center justify-center px-0"
                    aria-label={t('addAttachment')}
                    title={t('addAttachment')}
                  >
                    <Paperclip className="size-[18px]" />
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      onChange={(event) => {
                        const selected = Array.from(event.target.files ?? []).slice(0, 5);
                        const oversized = selected.find((file) => file.size > 10_000_000);
                        if (oversized) {
                          setSubmitError(t('attachmentTooLarge', { name: oversized.name }));
                        } else {
                          setSubmitError(null);
                          setAttachments(selected);
                        }
                        event.target.value = '';
                      }}
                    />
                  </label>
                  <div className="min-w-0 truncate text-xs text-muted-foreground">
                    {!ready ? t('chooseAModelBeforeSending') : uploadingAttachments ? t('uploadingAttachments') : activeConversationId ? t('conversationSelected') : t('conversationWillBeCreated')}
                  </div>
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-0 backdrop-blur-sm sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSettings();
          }}
        >
          <section
            ref={settingsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={settingsTitleId}
            className="ui-panel flex h-full w-full max-w-[96rem] flex-col overflow-hidden rounded-none shadow-xl sm:h-[calc(100dvh-2rem)] sm:rounded-md"
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
              <div className="min-w-0">
                <h2 id={settingsTitleId} className="flex items-center gap-2.5 truncate text-sm font-semibold text-foreground">
                  <Settings2 className="size-[18px] shrink-0 text-muted-foreground" />
                  {t('settings')}
                </h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{agentName}</p>
              </div>
              <button
                ref={settingsCloseButtonRef}
                type="button"
                aria-label={t('closeSettings')}
                title={t('closeSettings')}
                onClick={closeSettings}
                className="ui-button-secondary h-11 w-11 shrink-0 px-0"
              >
                <X className="size-5" />
              </button>
            </header>
            <div className={cx(
              'grid shrink-0 gap-1 border-b border-border px-2 py-3 sm:flex sm:gap-2 sm:overflow-x-auto sm:px-5',
              supportsChannelSettings ? 'grid-cols-2' : 'grid-cols-3',
            )}>
              <button
                type="button"
                onClick={() => setSettingsTab('agent')}
                className={cx(
                  'inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors sm:w-auto sm:shrink-0 sm:gap-2 sm:px-3.5 sm:text-sm',
                  settingsTab === 'agent'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <Settings2 className="size-3.5 shrink-0 sm:size-4" />
                {t('agentSettingsTab')}
              </button>
              {supportsChannelSettings ? (
                <button
                  type="button"
                  onClick={() => setSettingsTab('channels')}
                  className={cx(
                    'inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors sm:w-auto sm:shrink-0 sm:gap-2 sm:px-3.5 sm:text-sm',
                    settingsTab === 'channels'
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <Route className="size-3.5 shrink-0 sm:size-4" />
                  {t('channelSettingsTab')}
                </button>
              ) : null}
              {settings.runtime?.kind === 'hermes' ? (
                <>
                  <button
                    type="button"
                    onClick={() => setSettingsTab('hermes')}
                    className={cx(
                      'inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors sm:w-auto sm:shrink-0 sm:gap-2 sm:px-3.5 sm:text-sm',
                      settingsTab === 'hermes'
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    <Container className="size-3.5 shrink-0 sm:size-4" />
                    {t('hermesSettingsTab')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSettingsTab('terminal')}
                    className={cx(
                      'inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors sm:w-auto sm:shrink-0 sm:gap-2 sm:px-3.5 sm:text-sm',
                      settingsTab === 'terminal'
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    <Terminal className="size-3.5 shrink-0 sm:size-4" />
                    {t('terminalSettingsTab')}
                  </button>
                </>
              ) : null}
            </div>
            <div className={cx('min-h-0 flex-1', settingsTab === 'hermes' || settingsTab === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain')}>
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
                  runtime={settings.runtime}
                  className="mx-auto w-full max-w-5xl space-y-4 px-4 py-5 sm:px-6"
                />
              ) : settingsTab === 'channels' && supportsChannelSettings ? (
                <div className="mx-auto w-full max-w-6xl">
                  <AgentMessagingPanel
                    slug={slug}
                    agentId={agentId}
                    connections={channelSettings.connections}
                    ready={ready}
                  />
                </div>
              ) : settings.runtime?.kind === 'hermes' ? (
                <HermesRuntimePanel
                  view={settingsTab === 'hermes' ? 'web' : 'terminal'}
                  agentId={agentId}
                  deploymentId={settings.runtime.deploymentId}
                  dashboardUrl={settings.runtime.dashboardUrl}
                  iframeRef={hermesIframeRef}
                />
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
