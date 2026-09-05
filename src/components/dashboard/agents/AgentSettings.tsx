'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AgentResourceOption } from '@/components/dashboard/agents/AgentResourceSelect';
import type { ModelProviderOption } from '@/components/dashboard/models/ModelPicker';
import {
  AgentSettingsForm,
  type AgentSettingsSection,
} from '@/components/dashboard/agents/AgentSettingsForm';
import { AgentMarketSetupBanner } from '@/components/dashboard/agents/AgentMarketSetupBanner';
import type { AgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import type { AgentMarketSetupGuide } from '@/lib/agents/market-setup';
import type { AgentEndpointView } from '@/components/dashboard/agents/AgentApiPanel';

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

const HermesProfilesPanel = dynamic(() =>
  import('@/components/dashboard/agents/HermesProfilesPanel').then(
    (module) => module.HermesProfilesPanel,
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
  providers: Array<ModelProviderOption & { format: string }>;
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

type SettingsTab = AgentSettingsSection | 'channels' | 'api' | 'profiles' | 'hermes' | 'terminal';
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
  if (isHermesRuntime && ['profiles', 'hermes', 'terminal'].includes(requested)) return requested;
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
  marketSetup?: AgentMarketSetupGuide | null;
  initialSettingsTab?: InitialSettingsTab | null;
}) {
  const t = useTranslations('console.agents');
  const isHermesRuntime = settings.runtimeKind === 'hermes';
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
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const navigation = navigationRef.current;
    const active = activeTabRef.current;
    if (!navigation || !active) return;
    const bounds = navigation.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.left < bounds.left) navigation.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right) navigation.scrollLeft += item.right - bounds.right;
    if (item.top < bounds.top) navigation.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) navigation.scrollTop += item.bottom - bounds.bottom;
  }, [settingsTab]);

  const navigationItems: Array<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: t('general') },
    { id: 'instructions', label: t('instructions') },
    { id: 'builtInTools', label: t('builtInTools') },
    { id: 'mcp', label: t('mcp') },
    { id: 'skills', label: t('skills') },
    { id: 'toolkits', label: t('toolkits') },
    { id: 'sandboxes', label: t('sandboxes') },
    { id: 'subAgents', label: t('subAgents') },
    { id: 'advanced', label: t('advanced') },
    ...(supportsChannelSettings
      ? [{ id: 'channels' as const, label: t('channelSettingsTab') }]
      : [
          ...(apiSettings ? [{ id: 'api' as const, label: t('agentApiSettingsTab') }] : []),
          { id: 'profiles' as const, label: t('hermesProfilesSettingsTab') },
          { id: 'hermes' as const, label: t('hermesSettingsTab') },
          { id: 'terminal' as const, label: t('terminalSettingsTab') },
        ]),
  ];

  return (
    <div className="h-full min-h-0">
      <section aria-label={agentName} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {marketSetup ? <AgentMarketSetupBanner slug={slug} setup={marketSetup} /> : null}

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <aside className="flex min-h-0 shrink-0 flex-col border-b border-border/60 bg-muted/20 sm:w-48 sm:border-b-0 sm:border-r">
            <nav
              ref={navigationRef}
              aria-label={t('configurationNavigation')}
              className="flex w-full min-w-0 flex-1 gap-1 overflow-x-auto p-2 [scrollbar-width:none] sm:block sm:space-y-1 sm:overflow-y-auto sm:p-3 [&::-webkit-scrollbar]:hidden"
            >
              {navigationItems.map(({ id, label }) => {
                const active = settingsTab === id;
                return (
                  <button
                    key={id}
                    ref={active ? activeTabRef : undefined}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setSettingsTab(id)}
                    className={cx(
                      'inline-flex h-8 min-w-max items-center rounded-md px-2.5 text-sm transition-colors sm:flex sm:w-full',
                      active
                        ? 'bg-background font-medium text-foreground ring-1 ring-border'
                        : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                    )}
                  >
                    <span className="whitespace-nowrap">{label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
          <div className={cx(
            'min-h-0 min-w-0 flex-1',
            settingsTab === 'hermes' || settingsTab === 'terminal'
              ? 'overflow-hidden'
              : 'overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
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
              className="mx-auto w-full max-w-2xl space-y-4 px-5 py-6 sm:px-6"
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
          ) : settingsTab === 'profiles' && isHermesRuntime ? (
            <HermesProfilesPanel slug={slug} agentId={agentId} />
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
