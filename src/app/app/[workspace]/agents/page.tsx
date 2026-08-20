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
import { listSandboxes } from '@/lib/sandboxes/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { HERMES_IMAGE_OPTIONS, resolveHermesImage } from '@/lib/agents/hermes/constants';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { originFromHeaders } from '@/lib/http/origin';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspace: slug } = await params;
  const { tab } = await searchParams;
  if (tab === 'providers') redirect(`/app/${encodeURIComponent(slug)}/providers`);
  const t = await getTranslations('console.agents');

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');
  const hermesImages = [resolveHermesImage(undefined), ...HERMES_IMAGE_OPTIONS];
  const agentControlEndpoint = `${originFromHeaders(await headers())}/api/v1/workspaces/${encodeURIComponent(slug)}/agents/mcp`;

  const [agents, providers, deployments, skills, toolkits, sandboxes] = await Promise.all([
    listAgents(ws.id),
    listProviders(ws.id),
    listAgentDeploymentOptions(ws.id),
    listAgentSkillOptions(ws.id),
    listToolkits(ws.id),
    listSandboxes(ws.id),
  ]);

  return (
    <>
      <DashboardHeader title={t('title')} />
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
          conversationCount: a._count.conversations,
          runtimeKind: a.runtime?.kind ?? 'native',
          runtimeStatus: a.runtime
            ? ['error', 'setup_required'].includes(a.runtime.status)
              ? a.runtime.status
              : effectiveStatus(a.runtime.sandbox.deploymentId, a.runtime.sandbox.deployment.status)
            : null,
        }))}
        hermesImages={hermesImages}
        createOptions={{
          providers: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            models: provider.models,
          })),
          deployments,
          skills,
          toolkits: toolkits.map((toolkit) => ({
            id: toolkit.id,
            label: toolkit.name,
            status: toolkit.enabled ? 'enabled' : 'disabled',
          })),
          sandboxes: sandboxes.map((sandbox) => ({
            id: sandbox.id,
            label: sandbox.name,
            status: effectiveStatus(sandbox.deploymentId, sandbox.deployment.status),
          })),
        }}
      />
    </>
  );
}
