'use client';

import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import dynamic from 'next/dynamic';
import type { AgentResourceOption } from '@/components/dashboard/agents/AgentResourceSelect';
import { AgentConversation } from '@/components/dashboard/agents/AgentConversation';
import Link from 'next/link';
import {
  Container,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  Route,
  Settings2,
  Terminal,
  X,
} from 'lucide-react';
import { createConversationAction } from '@/lib/agents/actions';
import type { AgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import { HERMES_EMBED_CLOSE_MESSAGE } from '@/lib/agents/hermes/embed-message';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

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
  providerIds: string[];
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
    environment?: string;
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
const NARROW_VIEWPORT_QUERY = '(max-width: 1023px)';

function subscribeToNarrowViewport(onChange: () => void) {
  const media = window.matchMedia?.(NARROW_VIEWPORT_QUERY);
  if (!media) return () => undefined;
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getNarrowViewportSnapshot() {
  return window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches ?? false;
}

function getServerNarrowViewportSnapshot() {
  return false;
}

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
  const narrowViewport = useSyncExternalStore(
    subscribeToNarrowViewport,
    getNarrowViewportSnapshot,
    getServerNarrowViewportSnapshot,
  );
  const viewportMode = narrowViewport ? 'narrow' : 'wide';
  const [sidebarOverrides, setSidebarOverrides] = useState<
    Partial<Record<'narrow' | 'wide', boolean>>
  >({});
  const sidebarCollapsed = sidebarOverrides[viewportMode] ?? narrowViewport;
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarOverrides((current) => ({ ...current, [viewportMode]: collapsed }));
  }, [viewportMode]);
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initialSettingsTab));
  const [settingsTab, setSettingsTab] = useState<'agent' | 'channels' | 'hermes' | 'terminal'>(initialTab);
  const [createdConversation, setCreatedConversation] = useState<{
    selectedConversationId: string | null;
    id: string;
  } | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const selectedConversationIdRef = useRef<string | null>(conversationId);
  const activeConversationIdRef = useRef<string | null>(conversationId);
  const conversationCreationRef = useRef<Promise<string> | null>(null);
  const settingsTitleId = useId();
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsCloseButtonRef = useRef<HTMLButtonElement>(null);
  const settingsDialogRef = useRef<HTMLElement>(null);
  const hermesIframeRef = useRef<HTMLIFrameElement>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.has('settings')) {
      url.searchParams.delete('settings');
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    window.setTimeout(() => settingsButtonRef.current?.focus(), 0);
  }, []);
  const createdConversationId = createdConversation?.selectedConversationId === conversationId
    ? createdConversation.id
    : null;
  const activeConversationId = createdConversationId ?? conversationId;

  const conversationGroups = useMemo(() => {
    const external = conversations.filter((conversation) => conversation.source);
    const consoleChats = conversations.filter((conversation) => !conversation.source);
    return { external, consoleChats };
  }, [conversations]);

  useEffect(() => {
    selectedConversationIdRef.current = conversationId;
    activeConversationIdRef.current = conversationId;
  }, [conversationId]);

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

  const ensureConversation = useCallback(async (): Promise<string> => {
    if (activeConversationIdRef.current) return activeConversationIdRef.current;
    if (conversationCreationRef.current) return conversationCreationRef.current;

    setCreatingConversation(true);
    const selectedConversationId = selectedConversationIdRef.current;
    const creation = (async () => {
      const response = await fetch(`/api/v1/agents/${agentId}/conversations`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('conversation');
      const body = await response.json() as { conversationId?: string };
      if (!body.conversationId) throw new Error('conversation');
      if (selectedConversationIdRef.current === selectedConversationId) {
        activeConversationIdRef.current = body.conversationId;
        setCreatedConversation({
          selectedConversationId,
          id: body.conversationId,
        });
      }
      return body.conversationId;
    })();
    conversationCreationRef.current = creation;

    try {
      return await creation;
    } finally {
      if (conversationCreationRef.current === creation) {
        conversationCreationRef.current = null;
        setCreatingConversation(false);
      }
    }
  }, [agentId]);

  return (
    <div className="box-border flex h-[calc(100dvh-7.5rem-1px)] min-h-0 p-3 sm:p-4 lg:h-[calc(100dvh-4rem-1px)] lg:p-3">
      <div
        className={cx(
          'grid min-h-0 flex-1 gap-3',
          sidebarCollapsed ? 'grid-cols-1' : 'lg:grid-cols-[14rem_minmax(0,1fr)]',
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

          <AgentConversation
            key={`conversation:${conversationId ?? 'new'}`}
            activeConversationId={activeConversationId}
            agentId={agentId}
            agentName={agentName}
            creatingConversation={creatingConversation}
            ensureConversation={ensureConversation}
            initialMessages={initialMessages}
            ready={ready}
            runtimeKind={settings.runtime?.kind ?? null}
          />
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
                  providerIds={settings.providerIds}
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
