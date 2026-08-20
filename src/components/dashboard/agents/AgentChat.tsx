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
import { AgentMarketSetupBanner } from '@/components/dashboard/agents/AgentMarketSetupBanner';
import Link from 'next/link';
import {
  Bot,
  Boxes,
  Brain,
  Container,
  Code2,
  Globe2,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Plug,
  Radio,
  Route,
  Search,
  Settings2,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { createConversationAction } from '@/lib/agents/actions';
import type { AgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import type { AgentSettingsSection } from '@/components/dashboard/agents/AgentSettingsForm';
import { HERMES_EMBED_CLOSE_MESSAGE } from '@/lib/agents/hermes/embed-message';
import type { ParsedMessagingSession } from '@/lib/agents/messaging';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import type { AgentMarketSetupGuide } from '@/lib/agents/market-setup';
import type { AgentEndpointView } from '@/components/dashboard/agents/AgentApiPanel';

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

const AgentApiPanel = dynamic(() =>
  import('@/components/dashboard/agents/AgentApiPanel').then(
    (module) => module.AgentApiPanel,
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
  hermesImages?: string[];
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

type AgentApiSettingsData = {
  endpoint: AgentEndpointView | null;
  origin: string;
  canManage: boolean;
};

type SettingsTab = AgentSettingsSection | 'channels' | 'api' | 'hermes' | 'terminal';
type InitialSettingsTab = SettingsTab | 'agent';

const AGENT_SETTINGS_SECTIONS: readonly AgentSettingsSection[] = [
  'general',
  'instructions',
  'mcp',
  'skills',
  'toolkits',
  'sandboxes',
  'subAgents',
  'advanced',
];

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
  if (!source) return '';
  return `${titleCase(source.platform)} ${source.chatType.toUpperCase()}`;
}

function sourceDetail(source: ParsedMessagingSession | null) {
  if (!source) return '';
  return [source.chatId, source.contextId ? `context ${source.contextId}` : null].filter(Boolean).join(' · ');
}

function isAgentSettingsSection(tab: SettingsTab): tab is AgentSettingsSection {
  return AGENT_SETTINGS_SECTIONS.includes(tab as AgentSettingsSection);
}

export function AgentChat({
  slug,
  agentId,
  conversationId,
  initialMessages,
  conversations,
  settings,
  channelSettings,
  apiSettings,
  ready,
  agentName,
  providerLabel,
  marketSetup = null,
  initialSettingsTab,
}: {
  slug: string;
  agentId: string;
  conversationId: string | null;
  initialMessages: HermesUIMessage[];
  conversations: Conversation[];
  settings: SettingsData;
  channelSettings: ChannelSettingsData;
  apiSettings?: AgentApiSettingsData;
  ready: boolean;
  agentName: string;
  providerLabel: string;
  marketSetup?: AgentMarketSetupGuide | null;
  initialSettingsTab?: InitialSettingsTab | null;
}) {
  const t = useTranslations('console.agents');
  const isHermesRuntime = settings.runtime?.kind === 'hermes';
  const supportsChannelSettings = !isHermesRuntime;
  const supportsApiSettings = isHermesRuntime && Boolean(apiSettings);
  const requestedSettingsTab: SettingsTab = initialSettingsTab === 'agent'
    ? 'general'
    : initialSettingsTab ?? 'general';
  const initialTab: SettingsTab = (
    (!supportsChannelSettings && requestedSettingsTab === 'channels')
    || (!isHermesRuntime && ['api', 'hermes', 'terminal'].includes(requestedSettingsTab))
    || (!supportsApiSettings && requestedSettingsTab === 'api')
  ) ? 'general' : requestedSettingsTab;
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialTab);
  const [createdConversation, setCreatedConversation] = useState<{
    selectedConversationId: string | null;
    id: string;
  } | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [conversationQuery, setConversationQuery] = useState('');
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
  const visibleConversationGroups = useMemo(() => {
    const query = conversationQuery.trim().toLowerCase();
    if (!query) return conversationGroups;
    const matches = (conversation: Conversation) => [
      conversation.title ?? '',
      sourceLabel(conversation.source),
      sourceDetail(conversation.source),
    ].join(' ').toLowerCase().includes(query);
    return {
      external: conversationGroups.external.filter(matches),
      consoleChats: conversationGroups.consoleChats.filter(matches),
    };
  }, [conversationGroups, conversationQuery]);
  const resourceSummary = useMemo(() => [
    {
      key: 'mcp',
      label: t('mcp'),
      icon: Plug,
      count: settings.deployments.filter((resource) => resource.checked).length,
    },
    {
      key: 'skills',
      label: t('skills'),
      icon: Brain,
      count: settings.skills.filter((resource) => resource.checked).length,
    },
    {
      key: 'toolkits',
      label: t('toolkits'),
      icon: Wrench,
      count: settings.toolkits.filter((resource) => resource.checked).length,
    },
    {
      key: 'sandboxes',
      label: t('sandboxes'),
      icon: Boxes,
      count: settings.sandboxes.filter((resource) => resource.checked).length,
    },
  ], [settings.deployments, settings.sandboxes, settings.skills, settings.toolkits, t]);
  const configuredResourceCount = resourceSummary.reduce((total, resource) => total + resource.count, 0);
  const settingsNavigationGroups: Array<{
    label: string;
    items: Array<{ id: AgentSettingsSection; label: string; icon: typeof Bot }>;
  }> = [
    {
      label: t('basic'),
      items: [
        { id: 'general', label: t('general'), icon: Bot },
        { id: 'instructions', label: t('instructions'), icon: Brain },
      ],
    },
    {
      label: t('tools'),
      items: [
        { id: 'mcp', label: t('mcp'), icon: Plug },
        { id: 'skills', label: t('skills'), icon: Brain },
        { id: 'toolkits', label: t('toolkits'), icon: Wrench },
        { id: 'sandboxes', label: t('sandboxes'), icon: Boxes },
        { id: 'subAgents', label: t('subAgents'), icon: Bot },
      ],
    },
    {
      label: t('advanced'),
      items: [{ id: 'advanced', label: t('advanced'), icon: Settings2 }],
    },
  ];

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
          sidebarCollapsed ? 'grid-cols-1' : 'lg:grid-cols-[17rem_minmax(0,1fr)]',
        )}
      >
        {!sidebarCollapsed ? (
        <aside className="ui-panel flex min-h-0 flex-col overflow-hidden bg-card/80">
          <div className="border-b border-border bg-muted/10 px-3 py-3">
            <div className="flex items-center gap-2.5">
              <form action={createConversationAction} className="min-w-0 flex-1">
                <input type="hidden" name="workspace" value={slug} />
                <input type="hidden" name="agentId" value={agentId} />
                <button className="ui-button-primary h-9 w-full gap-2" type="submit">
                  <Plus className="size-4 shrink-0" />
                  {t('newChat')}
                </button>
              </form>
              <button
                type="button"
                aria-label={t('hideConversations')}
                title={t('hideConversations')}
                onClick={() => setSidebarCollapsed(true)}
                className="ui-button-secondary h-9 w-9 shrink-0 px-0"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </div>
            <div className="relative mt-2.5">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={conversationQuery}
                onChange={(event) => setConversationQuery(event.target.value)}
                placeholder={t('searchConversations')}
                aria-label={t('searchConversations')}
                className="ui-input h-8 w-full pl-8 pr-8 text-xs"
              />
              {conversationQuery ? (
                <button
                  type="button"
                  onClick={() => setConversationQuery('')}
                  aria-label={t('clearConversationSearch')}
                  title={t('clearConversationSearch')}
                  className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="border-b border-border px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Radio className="size-4 shrink-0" />
                  {t('channels')}
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground">{visibleConversationGroups.external.length}</span>
              </div>
              <ul className="space-y-1">
                {visibleConversationGroups.external.map((conversation) => (
                  <li key={conversation.id}>
                    <Link
                      href={`/app/${slug}/agents/${agentId}?c=${conversation.id}`}
                      className={cx(
                        'block rounded-md border border-transparent px-3 py-2.5 text-sm transition-colors',
                        conversation.id === activeConversationId
                          ? 'border-brand/20 bg-brand-soft text-accent-foreground shadow-sm'
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
                {visibleConversationGroups.external.length === 0 ? (
                  <li className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                    {conversationQuery ? t('noConversationsMatch') : t('connectedChannelsWillAppearHereAfterTheirFirstMessage')}
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
                <span className="text-[11px] tabular-nums text-muted-foreground">{visibleConversationGroups.consoleChats.length}</span>
              </div>
              <ul className="space-y-1">
                {visibleConversationGroups.consoleChats.map((conversation) => (
                  <li key={conversation.id}>
                    <Link
                      href={`/app/${slug}/agents/${agentId}?c=${conversation.id}`}
                      className={cx(
                        'block rounded-md border border-transparent px-3 py-2.5 text-sm transition-colors',
                        conversation.id === activeConversationId
                          ? 'border-brand/20 bg-brand-soft text-accent-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">
                          {conversation.title ?? t('chatCreatedOn', { date: conversation.createdAt })}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">
                          {conversation.lastMessageAt
                            ? t('lastMessageOn', { date: conversation.lastMessageAt })
                            : t('noMessagesYet')}
                        </span>
                        <span className="shrink-0 tabular-nums">{conversation.messageCount}</span>
                      </div>
                    </Link>
                  </li>
                ))}
                {visibleConversationGroups.consoleChats.length === 0 ? (
                  <li className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                    {conversationQuery ? t('noConversationsMatch') : t('noMessagesYet')}
                  </li>
                ) : null}
              </ul>
            </section>

          </div>
        </aside>
        ) : null}

        <section className="ui-panel flex min-h-0 min-w-0 flex-col overflow-hidden">
          <header className="shrink-0 border-b border-border bg-card/80 px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                {sidebarCollapsed ? (
                  <button
                    type="button"
                    aria-label={t('showConversations')}
                    title={t('showConversations')}
                    onClick={() => setSidebarCollapsed(false)}
                    className="ui-button-secondary h-9 w-9 shrink-0 px-0"
                  >
                    <PanelLeftOpen className="size-4" />
                  </button>
                ) : null}
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand-soft text-brand">
                  <Bot className="size-[18px]" />
                </span>
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
                  <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('configuredResources')}>
                    {resourceSummary.filter((resource) => resource.count > 0).map((resource) => {
                      const Icon = resource.icon;
                      return (
                        <span
                          key={resource.key}
                          title={`${resource.label}: ${resource.count}`}
                          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-[10px] font-medium text-muted-foreground"
                        >
                          <Icon className="size-3" />
                          {resource.count} {resource.label}
                        </span>
                      );
                    })}
                    {configuredResourceCount === 0 ? (
                      <span className="inline-flex h-6 items-center rounded-md border border-dashed border-border px-1.5 text-[10px] text-muted-foreground">
                        {t('noConfiguredResources')}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Link
                  href={`/app/${slug}/agents/${agentId}/publish`}
                  className="ui-button-secondary h-10 shrink-0 gap-2 px-4"
                >
                  <Globe2 className="size-[18px] shrink-0" />
                  {t('publishAgent')}
                </Link>
                <button
                  ref={settingsButtonRef}
                  type="button"
                  aria-label={t('settings')}
                  title={t('settings')}
                  onClick={() => {
                    setSettingsTab('general');
                    setSettingsOpen(true);
                  }}
                  className="ui-button-secondary h-10 shrink-0 gap-2 px-4"
                >
                  <Settings2 className="size-[18px] shrink-0" />
                  {t('settings')}
                </button>
              </div>
            </div>
          </header>

          {marketSetup ? (
            <AgentMarketSetupBanner
              slug={slug}
              setup={marketSetup}
            />
          ) : null}

          {!ready && !marketSetup ? (
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
            className="ui-panel flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-none shadow-xl sm:h-[calc(100dvh-2rem)] sm:rounded-lg"
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 sm:px-5 sm:py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand-soft text-brand">
                  {isHermesRuntime ? <Container className="size-[18px]" /> : <Bot className="size-[18px]" />}
                </span>
                <div className="min-w-0">
                  <h2 id={settingsTitleId} className="truncate text-sm font-semibold text-foreground">
                    {t('settings')}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {agentName} · {isHermesRuntime ? 'Hermes' : t('nativeRuntime')}
                  </p>
                </div>
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
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <aside className="shrink-0 border-b border-border bg-muted/10 lg:w-52 lg:border-b-0 lg:border-r">
                <nav className="flex min-w-max gap-4 overflow-x-auto p-2 lg:block lg:min-w-0 lg:space-y-5 lg:overflow-visible lg:p-3" aria-label={t('configurationNavigation')}>
                  {settingsNavigationGroups.map((group) => (
                    <div key={group.label} className="flex shrink-0 items-center gap-1.5 lg:block lg:space-y-1">
                      <p className="hidden px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground lg:block">
                        {group.label}
                      </p>
                      {group.items.map(({ id, label, icon: Icon }) => {
                        const active = settingsTab === id;
                        return (
                          <button
                            key={id}
                            type="button"
                            aria-current={active ? 'page' : undefined}
                            onClick={() => setSettingsTab(id)}
                            className={cx(
                              'inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:flex lg:w-full',
                              active
                                ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
                                : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                            )}
                          >
                            <Icon className="size-4 shrink-0" />
                            <span className="whitespace-nowrap">{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}

                  {supportsChannelSettings || isHermesRuntime ? (
                    <div className="flex shrink-0 items-center gap-1.5 border-l border-border pl-4 lg:block lg:border-l-0 lg:border-t lg:pl-0 lg:pt-4">
                      <p className="hidden px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground lg:block">
                        {isHermesRuntime ? t('runtime') : t('channels')}
                      </p>
                      {supportsChannelSettings ? (
                        <button
                          type="button"
                          aria-current={settingsTab === 'channels' ? 'page' : undefined}
                          onClick={() => setSettingsTab('channels')}
                          className={cx(
                            'inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:flex lg:w-full',
                            settingsTab === 'channels'
                              ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
                              : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                          )}
                        >
                          <Route className="size-4 shrink-0" />
                          <span className="whitespace-nowrap">{t('channelSettingsTab')}</span>
                        </button>
                      ) : null}
                      {isHermesRuntime ? (
                        <>
                          {apiSettings ? (
                            <button
                              type="button"
                              aria-current={settingsTab === 'api' ? 'page' : undefined}
                              onClick={() => setSettingsTab('api')}
                              className={cx(
                                'inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:flex lg:w-full',
                                settingsTab === 'api'
                                  ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
                                  : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                              )}
                            >
                              <Code2 className="size-4 shrink-0" />
                              <span className="whitespace-nowrap">{t('agentApiSettingsTab')}</span>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-current={settingsTab === 'hermes' ? 'page' : undefined}
                            onClick={() => setSettingsTab('hermes')}
                            className={cx(
                              'inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:flex lg:w-full',
                              settingsTab === 'hermes'
                                ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
                                : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                            )}
                          >
                            <Container className="size-4 shrink-0" />
                            <span className="whitespace-nowrap">{t('hermesSettingsTab')}</span>
                          </button>
                          <button
                            type="button"
                            aria-current={settingsTab === 'terminal' ? 'page' : undefined}
                            onClick={() => setSettingsTab('terminal')}
                            className={cx(
                              'inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:flex lg:w-full',
                              settingsTab === 'terminal'
                                ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
                                : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                            )}
                          >
                            <Terminal className="size-4 shrink-0" />
                            <span className="whitespace-nowrap">{t('terminalSettingsTab')}</span>
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </nav>
              </aside>
              <div className={cx('min-h-0 min-w-0 flex-1', settingsTab === 'hermes' || settingsTab === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain')}>
                {isAgentSettingsSection(settingsTab) ? (
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
                    hermesImages={settings.hermesImages}
                    runtime={settings.runtime}
                    activeSection={settingsTab}
                    onSectionChange={setSettingsTab}
                    showNavigation={false}
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
                ) : settingsTab === 'api' && settings.runtime?.kind === 'hermes' && apiSettings ? (
                  <AgentApiPanel
                    key={`${apiSettings.endpoint?.id ?? 'draft'}:${apiSettings.endpoint?.revision ?? 0}`}
                    workspaceSlug={slug}
                    agentId={agentId}
                    agentName={agentName}
                    origin={apiSettings.origin}
                    canManage={apiSettings.canManage}
                    endpoint={apiSettings.endpoint}
                    deployments={settings.deployments}
                    skills={settings.skills}
                  />
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
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
