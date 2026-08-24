import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listToolkits } from '@/lib/toolkits/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import {
  getAgentPageData,
  listAgentDeploymentOptions,
  listAgents,
  listAgentSkillOptions,
  listProviders,
  resolveAgentMarketSetupGuide,
} from '@/lib/agents/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { AgentSettings } from '@/components/dashboard/agents/AgentSettings';
import { listAgentChannelConnections } from '@/lib/agents/channel-connections';
import { toAgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import { createHermesDashboardPath } from '@/lib/agents/hermes/token';
import { HERMES_IMAGE_OPTIONS, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { SettingsModal } from '@/components/dashboard/SettingsModal';
import { readSandboxEnv, sandboxEnvToText } from '@/lib/sandboxes/env';
import { originFromHeaders } from '@/lib/http/origin';
import { getAgentEndpointForManagement } from '@/lib/agents/public-api/queries';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function isoDate(value: Date | string | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

function latestDate(values: Array<Date | string | null>): string | null {
  let latest: Date | string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isFinite(time) && time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return isoDate(latest);
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; agentId: string }>;
  searchParams: Promise<{ c?: string; settings?: string; tab?: string }>;
}) {
  const { workspace: slug, agentId } = await params;
  const { c, settings, tab } = await searchParams;
  const t = await getTranslations('console.agents');

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const hermesImages = [resolveHermesImage(undefined), ...HERMES_IMAGE_OPTIONS];

  const agent = await getAgentPageData(ws.id, agentId);
  if (!agent) notFound();

  if (c || tab === 'chat') {
    const query = new URLSearchParams({ agent: agentId });
    if (c) query.set('c', c);
    redirect(`/app/${slug}/chat?${query}`);
  }

  const isHermes = agent.runtime?.kind === 'hermes';
  const ready = isHermes
    ? agent.modelProviders.length > 0
    : Boolean(agent.providerId && agent.model);
  const providerLabel = isHermes
    ? agent.modelProviders.length > 0
      ? agent.modelProviders.map((link) => link.provider.name).join(', ')
      : t('noModelProvidersSelected')
    : agent.provider
      ? `${agent.provider.name} · ${agent.model ?? t('noModelSelected')}`
      : t('noProviderSelected');
  const selectedDeps = new Set(agent.servers.map((server) => server.deploymentId));
  const selectedSkills = new Set(agent.skills.map((skill) => skill.installedSkillId));
  const [
    channelConnections,
    providers,
    deployments,
    skills,
    toolkits,
    sandboxes,
    agents,
    apiEndpoint,
    managerMembership,
    requestHeaders,
  ] = await Promise.all([
    agent.runtime?.kind === 'hermes'
      ? Promise.resolve([])
      : listAgentChannelConnections(ws.id, agentId),
    listProviders(ws.id),
    listAgentDeploymentOptions(ws.id, selectedDeps),
    listAgentSkillOptions(ws.id, selectedSkills),
    listToolkits(ws.id),
    listSandboxes(ws.id),
    listAgents(ws.id),
    isHermes ? getAgentEndpointForManagement(ws.id, agentId) : Promise.resolve(null),
    !isHermes || ws.ownerId === user.id
      ? Promise.resolve(null)
      : db.membership.findUnique({
        where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } },
        select: { role: true },
      }),
    headers(),
  ]);

  const selectedToolkits = new Set(agent.toolkits.map((toolkit) => toolkit.toolkitId));
  const selectedSandboxes = new Set(agent.sandboxes.map((sandbox) => sandbox.sandboxId));
  const selectedSubAgents = new Set(agent.subAgents.map((subAgent) => subAgent.childId));
  const marketSetup = await resolveAgentMarketSetupGuide(ws.id, agent.marketInstall);

  return (
    <SettingsModal title={t('agentSettings')} fallbackHref={`/app/${slug}/agents`}>
      <AgentSettings
        key={settings ?? 'general'}
        slug={slug}
        agentId={agentId}
        settings={{
          name: agent.name,
          systemPrompt: agent.runtime?.kind === 'hermes' ? '' : agent.systemPrompt ?? '',
          providerId: agent.providerId,
          providerIds: agent.modelProviders.map((link) => link.providerId),
          model: agent.model,
          maxSteps: agent.maxSteps,
          providers: providers.map((p) => ({ id: p.id, name: p.name, models: p.models })),
          deployments,
          skills,
          toolkits: toolkits.map((t) => ({
            id: t.id,
            label: t.name,
            checked: selectedToolkits.has(t.id),
            status: t.enabled ? 'enabled' : 'disabled',
          })),
          defaultSandboxId: agent.sandboxes.find((sandbox) => sandbox.isDefault)?.sandboxId ?? null,
          sandboxes: sandboxes
            .filter((s) => {
              if (s.id === agent.runtime?.sandboxId) return false;
              return ![
                'copying',
                'copy_failed',
                'restoring',
                'restore_failed',
                'restore_cleanup_required',
                'upgrading',
                'deleting',
              ]
                .includes(effectiveStatus(s.deploymentId, s.deployment.status));
            })
            .map((s) => ({
              id: s.id,
              label: s.name,
              checked: selectedSandboxes.has(s.id),
              status: effectiveStatus(s.deploymentId, s.deployment.status),
            })),
          subAgents: agents
            .filter((a) => a.id !== agentId)
            .map((a) => ({
              id: a.id,
              label: a.name,
              checked: selectedSubAgents.has(a.id),
            })),
          hermesImages,
          runtime: agent.runtime ? (() => {
            return {
              kind: agent.runtime.kind,
              image: agent.runtime.image,
              status: ['error', 'setup_required'].includes(agent.runtime.status)
                ? agent.runtime.status
                : effectiveStatus(agent.runtime.sandbox.deploymentId, agent.runtime.sandbox.deployment.status),
              lastError: agent.runtime.lastError,
              lastSyncedAt: agent.runtime.lastSyncedAt?.toISOString() ?? null,
              sandboxId: agent.runtime.sandboxId,
              environment: sandboxEnvToText(readSandboxEnv(agent.runtime.sandbox.config)),
              deploymentId: agent.runtime.sandbox.deploymentId,
              dashboardUrl: createHermesDashboardPath(agent.runtime.id),
            };
          })() : null,
        }}
        channelSettings={{
          connections: channelConnections.map(toAgentChannelConnectionClientView),
        }}
        apiSettings={isHermes ? {
          origin: originFromHeaders(requestHeaders),
          canManage: ws.ownerId === user.id || managerMembership?.role === 'admin',
          endpoint: apiEndpoint?.currentRevision ? (() => {
            const revision = apiEndpoint.currentRevision;
            return {
              id: apiEndpoint.publicId,
              status: apiEndpoint.status,
              name: apiEndpoint.name,
              isolationMode: apiEndpoint.isolationMode,
              rpmLimit: apiEndpoint.rpmLimit,
              dailyRequestLimit: apiEndpoint.dailyRequestLimit,
              dailyOutputCharacterLimit: apiEndpoint.dailyOutputCharacterLimit,
              maxConcurrent: apiEndpoint.maxConcurrent,
              maxRuntimes: apiEndpoint.maxRuntimes,
              maxStoredCharacters: apiEndpoint.maxStoredCharacters,
              timeoutSeconds: apiEndpoint.timeoutSeconds,
              retentionDays: apiEndpoint.retentionDays,
              systemPrompt: revision.systemPrompt,
              allowedOrigins: apiEndpoint.allowedOrigins,
              revision: revision.version,
              deploymentIds: revision.deploymentIds,
              skillIds: revision.installedSkillIds,
              clients: apiEndpoint.clients.map((client) => ({
                id: client.id,
                name: client.name,
                createdAt: isoDate(client.createdAt) ?? '',
                lastUsedAt: latestDate(client.keys.map((key) => key.lastUsedAt)),
                keys: client.keys.map((key) => ({
                  id: key.id,
                  name: key.name,
                  prefix: key.prefix,
                  createdAt: isoDate(key.createdAt) ?? '',
                  lastUsedAt: isoDate(key.lastUsedAt),
                  expiresAt: isoDate(key.expiresAt),
                  revokedAt: isoDate(key.revokedAt),
                })),
              })),
            };
          })() : null,
        } : undefined}
        ready={ready}
        agentName={agent.name}
        providerLabel={providerLabel}
        marketSetup={marketSetup}
        initialSettingsTab={settings === 'channels' && agent.runtime?.kind !== 'hermes' ? 'channels' : settings === 'api' && isHermes ? 'api' : settings === 'hermes' ? 'hermes' : settings === 'terminal' ? 'terminal' : settings === 'agent' ? 'agent' : null}
      />
    </SettingsModal>
  );
}
