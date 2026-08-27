'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bot,
  Box,
  Brain,
  Code2,
  Container,
  FileText,
  Hammer,
  MessageSquare,
  Play,
  Plug,
  Route,
  Settings2,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AgentResourceOption } from '@/components/dashboard/agents/AgentResourceSelect';
import {
  AgentSettingsForm,
  type AgentSettingsSection,
} from '@/components/dashboard/agents/AgentSettingsForm';
import { AgentMarketSetupBanner } from '@/components/dashboard/agents/AgentMarketSetupBanner';
import type { AgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import type { AgentMarketSetupGuide } from '@/lib/agents/market-setup';
import type { AgentEndpointView } from '@/components/dashboard/agents/AgentApiPanel';
import { isDedicatedSandboxRuntimeKind } from '@/lib/agents/runtime-kind';
import { startSandboxAction } from '@/lib/sandboxes/actions';
import { SubmitButton } from '@/components/dashboard/SubmitButton';

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

type SettingsData = {
  name: string;
  runtimeKind: string;
  systemPrompt: string;
  providerId: string | null;
  providerIds: string[];
  model: string | null;
  maxSteps: number;
  providers: Array<{ id: string; name: string; format: string; models: string[] }>;
  deployments: AgentResourceOption[];
  skills: AgentResourceOption[];
  toolkits: AgentResourceOption[];
  defaultSandboxId?: string | null;
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
  'builtInTools',
  'mcp',
  'skills',
  'toolkits',
  'sandboxes',
  'subAgents',
  'advanced',
];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function isAgentSettingsSection(tab: SettingsTab): tab is AgentSettingsSection {
  return AGENT_SETTINGS_SECTIONS.includes(tab as AgentSettingsSection);
}

function resolveSettingsTab({
  initialSettingsTab,
  isHermesRuntime,
  supportsChannelSettings,
  supportsApiSettings,
}: {
  initialSettingsTab?: InitialSettingsTab | null;
  isHermesRuntime: boolean;
  supportsChannelSettings: boolean;
  supportsApiSettings: boolean;
}): SettingsTab {
  const requested = initialSettingsTab === 'agent'
    ? 'general'
    : initialSettingsTab ?? 'general';
  if (isAgentSettingsSection(requested)) return requested;
  if (requested === 'channels' && supportsChannelSettings) return requested;
  if (requested === 'api' && supportsApiSettings) return requested;
  if (isHermesRuntime && (requested === 'hermes' || requested === 'terminal')) return requested;
  return 'general';
}

export function AgentSettings({
  slug,
  agentId,
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
  const tSandboxes = useTranslations('console.sandboxes');
  const isHermesRuntime = settings.runtimeKind === 'hermes';
  const selectedSandboxes = settings.sandboxes.filter((sandbox) => sandbox.checked);
  const managedSandbox = isHermesRuntime && settings.runtime
    ? { id: settings.runtime.sandboxId, status: settings.runtime.status }
    : selectedSandboxes[0] ?? null;
  const canStartSandbox = managedSandbox
    ? managedSandbox.status === 'stopped' || managedSandbox.status === 'error'
    : false;
  const dedicatedSandboxReady = !isDedicatedSandboxRuntimeKind(settings.runtimeKind)
    || (
      selectedSandboxes.length === 1
      && selectedSandboxes[0]?.kind === 'docker'
      && selectedSandboxes[0]?.network !== 'none'
    );
  const supportsChannelSettings = !isHermesRuntime;
  const supportsApiSettings = isHermesRuntime && Boolean(apiSettings);
  const requestedTab = resolveSettingsTab({
    initialSettingsTab,
    isHermesRuntime,
    supportsChannelSettings,
    supportsApiSettings,
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(requestedTab);
  const hermesIframeRef = useRef<HTMLIFrameElement>(null);

  const navigationGroups: Array<{
    label: string;
    items: Array<{ id: SettingsTab; label: string; icon: LucideIcon }>;
  }> = [
    {
      label: t('basic'),
      items: [
        { id: 'general', label: t('general'), icon: Bot },
        { id: 'instructions', label: t('instructions'), icon: FileText },
      ],
    },
    {
      label: t('tools'),
      items: [
        { id: 'builtInTools', label: t('builtInTools'), icon: Hammer },
        { id: 'mcp', label: t('mcp'), icon: Plug },
        { id: 'skills', label: t('skills'), icon: Brain },
        { id: 'toolkits', label: t('toolkits'), icon: Wrench },
        { id: 'sandboxes', label: t('sandboxes'), icon: Box },
        { id: 'subAgents', label: t('subAgents'), icon: Users },
      ],
    },
    {
      label: t('advanced'),
      items: [{ id: 'advanced', label: t('advanced'), icon: Settings2 }],
    },
    {
      label: isHermesRuntime ? t('runtime') : t('channels'),
      items: supportsChannelSettings
        ? [{ id: 'channels', label: t('channelSettingsTab'), icon: Route }]
        : [
            ...(apiSettings ? [{ id: 'api' as const, label: t('agentApiSettingsTab'), icon: Code2 }] : []),
            { id: 'hermes', label: t('hermesSettingsTab'), icon: Container },
            { id: 'terminal', label: t('terminalSettingsTab'), icon: Terminal },
          ],
    },
  ];

  return (
    <div className="h-full min-h-0">
      <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <header className="shrink-0 bg-background px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              {isHermesRuntime ? <Container className="size-[18px]" /> : <Bot className="size-[18px]" />}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">{agentName}</h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{providerLabel}</p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {canStartSandbox && managedSandbox ? (
                <form action={startSandboxAction}>
                  <input type="hidden" name="workspace" value={slug} />
                  <input type="hidden" name="sandboxId" value={managedSandbox.id} />
                  <SubmitButton
                    pendingLabel={tSandboxes('starting')}
                    flash={false}
                    className="ui-button-secondary h-8 px-2.5 text-xs"
                  >
                    <Play className="size-3.5" />
                    {tSandboxes('start')}
                  </SubmitButton>
                </form>
              ) : null}
              {ready ? (
                <Link
                  href={`/app/${encodeURIComponent(slug)}/chat?agent=${encodeURIComponent(agentId)}`}
                  aria-label={t('chat')}
                  title={t('chat')}
                  className="ui-button-secondary size-8 shrink-0 px-0"
                >
                  <MessageSquare className="size-4" />
                </Link>
              ) : null}
              <span
                className={cx(
                  'inline-flex h-6 shrink-0 items-center rounded-md px-2 text-xs font-medium',
                  ready
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                )}
              >
                {ready ? t('ready2') : dedicatedSandboxReady ? t('needsModel') : t('needsSandbox')}
              </span>
            </div>
          </div>
        </header>

        {marketSetup ? <AgentMarketSetupBanner slug={slug} setup={marketSetup} /> : null}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <aside className="shrink-0 bg-muted/10 lg:w-52">
            <nav
              aria-label={t('configurationNavigation')}
              className="flex min-w-max gap-4 overflow-x-auto p-2 lg:block lg:min-w-0 lg:space-y-5 lg:overflow-visible lg:p-3"
            >
              {navigationGroups.map((group) => (
                <div key={group.label} className="flex shrink-0 items-center gap-1.5 lg:block lg:space-y-1">
                  <p className="hidden px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground lg:block">
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
                          'inline-flex h-10 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors lg:flex lg:h-9 lg:w-full',
                          active
                            ? 'bg-background font-medium text-foreground ring-1 ring-border'
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
            </nav>
          </aside>
          <div className={cx(
            'min-h-0 min-w-0 flex-1',
            settingsTab === 'hermes' || settingsTab === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain',
          )}>
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
              defaultSandboxId={settings.defaultSandboxId}
              sandboxes={settings.sandboxes}
              subAgents={settings.subAgents}
              hermesImages={settings.hermesImages}
              runtimeKind={settings.runtimeKind}
              runtime={settings.runtime}
              activeSection={settingsTab}
              onSectionChange={setSettingsTab}
              showNavigation={false}
              className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5 sm:px-6"
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
          ) : settingsTab === 'api' && isHermesRuntime && apiSettings ? (
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
          ) : isHermesRuntime && settings.runtime ? (
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
  );
}
