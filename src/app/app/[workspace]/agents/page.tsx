import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  listAgentDeploymentOptions,
  listAgents,
  listAgentSkillOptions,
  listProviders,
} from '@/lib/agents/queries';
import { AgentsBrowser } from '@/components/dashboard/agents/AgentsBrowser';
import { listToolkits } from '@/lib/toolkits/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { HERMES_IMAGE_OPTIONS, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { SettingsModal } from '@/components/dashboard/SettingsModal';
import { originFromHeaders } from '@/lib/http/origin';
import { listAgentMarketListings } from '@/lib/agents/market';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string; create?: string }>;
}) {
  const { workspace: slug } = await params;
  const { tab, create } = await searchParams;
  if (tab === 'providers') redirect(`/app/${encodeURIComponent(slug)}/providers`);
  const t = await getTranslations('console.agents');

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const hermesImages = [resolveHermesImage(undefined), ...HERMES_IMAGE_OPTIONS];
  const agentControlEndpoint = `${originFromHeaders(await headers())}/api/v1/workspaces/${encodeURIComponent(slug)}/agents/mcp`;

  const [agents, providers, deployments, skills, toolkits, marketAgents] = await Promise.all([
    listAgents(ws.id),
    listProviders(ws.id),
    listAgentDeploymentOptions(ws.id),
    listAgentSkillOptions(ws.id),
    listToolkits(ws.id),
    listAgentMarketListings({ pageSize: 12, sort: 'popular' }),
  ]);
  const defaultModelProviderId = ws.defaultModelProviderId;
  const defaultModelId = ws.defaultModel;
  const defaultModel = defaultModelProviderId && defaultModelId
    && providers.some((provider) => provider.id === defaultModelProviderId && provider.models.includes(defaultModelId))
    ? { providerId: defaultModelProviderId, model: defaultModelId }
    : null;

  return (
    <SettingsModal
      title={create === '1' ? t('newAgent') : t('title')}
      fallbackHref={`/app/${slug}/work`}
      compact={create === '1'}
    >
      <div className="h-full overflow-y-auto">
        <AgentsBrowser
        slug={slug}
        agentControlEndpoint={agentControlEndpoint}
        agents={agents.map((a) => ({
          id: a.id,
          name: a.name,
          providerName: a.provider?.name ?? null,
          providerNames: a.modelProviders.map((link) => link.provider.name),
          model: a.model,
          toolCount: a._count.servers + a._count.skills + a._count.toolkits + a._count.sandboxes,
          subAgentCount: a._count.subAgents,
          runtimeKind: a.runtimeKind,
          sandboxReady: a.sandboxes.length === 1
            && a.sandboxes[0]?.sandbox.kind === 'docker'
            && a.sandboxes[0]?.sandbox.network !== 'none',
          runtimeStatus: a.runtime
            ? ['error', 'setup_required'].includes(a.runtime.status)
              ? a.runtime.status
              : effectiveStatus(a.runtime.sandbox.deploymentId, a.runtime.sandbox.deployment.status)
            : null,
        }))}
        marketAgents={marketAgents.items.map((agent) => ({
          id: agent.id,
          releaseId: agent.latestReleaseId,
          idempotencyKey: randomUUID(),
          name: agent.name,
          summary: agent.summary,
          iconUrl: agent.iconUrl,
          publisher: agent.author ?? agent.workspaceName ?? agent.workspaceSlug,
          tags: [...agent.categories.map((category) => category.name), ...agent.tags].slice(0, 3),
          runtimes: agent.releaseSummary.runtimes,
          resourceCount: agent.releaseSummary.resourceCount,
          sandboxCount: agent.releaseSummary.agentCount,
          installCount: agent.installCount,
        }))}
        hermesImages={hermesImages}
        createOptions={{
          providers: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            format: provider.format,
            models: provider.models,
            modelRecords: (provider.modelRecords ?? []).map((model) => ({
              modelId: model.modelId,
              primaryType: model.primaryType,
              capabilities: model.capabilities,
              inputModalities: model.inputModalities,
            })),
          })),
          defaultModel,
          deployments,
          skills,
          toolkits: toolkits.map((toolkit) => ({
            id: toolkit.id,
            label: toolkit.name,
            status: toolkit.enabled ? 'enabled' : 'disabled',
          })),
        }}
        />
      </div>
    </SettingsModal>
  );
}
