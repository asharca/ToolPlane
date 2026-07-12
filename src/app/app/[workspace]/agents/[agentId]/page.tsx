import { redirect, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { UIMessage } from 'ai';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listToolkits } from '@/lib/toolkits/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import {
  getAgentPageData,
  getConversation,
  listAgentDeploymentOptions,
  listAgents,
  listAgentSkillOptions,
  listConversations,
  listProviders,
} from '@/lib/agents/queries';
import { effectiveStatus } from '@/lib/process/supervisor';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';
import { listAgentChannelConnections } from '@/lib/agents/channel-connections';
import { toAgentChannelConnectionClientView } from '@/lib/agents/channel-connection-client';
import { parseMessagingSessionTitle } from '@/lib/agents/messaging';
import { createHermesDashboardPath } from '@/lib/agents/hermes/token';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';

export const dynamic = 'force-dynamic';

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; agentId: string }>;
  searchParams: Promise<{ c?: string; settings?: string }>;
}) {
  const { workspace: slug, agentId } = await params;
  const { c, settings } = await searchParams;
  const t = await getTranslations('console.agents');

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const agent = await getAgentPageData(ws.id, agentId);
  if (!agent) notFound();

  const ready = Boolean(agent.providerId && agent.model);
  const providerLabel = agent.provider
    ? `${agent.provider.name} · ${agent.model ?? 'no model selected'}`
    : 'No model provider selected';
  const selectedDeps = new Set(agent.servers.map((server) => server.deploymentId));
  const selectedSkills = new Set(agent.skills.map((skill) => skill.installedSkillId));
  const [
    conversations,
    channelConnections,
    providers,
    deployments,
    skills,
    toolkits,
    sandboxes,
    agents,
  ] = await Promise.all([
    listConversations(agentId),
    listAgentChannelConnections(ws.id, agentId),
    listProviders(ws.id),
    listAgentDeploymentOptions(ws.id, selectedDeps),
    listAgentSkillOptions(ws.id, selectedSkills),
    listToolkits(ws.id),
    listSandboxes(ws.id),
    listAgents(ws.id),
  ]);

  const activeId = c ?? conversations[0]?.id ?? null;
  const loaded = activeId ? await getConversation(activeId, ws.id) : null;
  const conv = loaded && loaded.agentId === agentId ? loaded : null;
  const initialMessages: UIMessage[] = (conv?.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role as UIMessage['role'],
    parts: m.parts as UIMessage['parts'],
  }));

  const selectedToolkits = new Set(agent.toolkits.map((toolkit) => toolkit.toolkitId));
  const selectedSandboxes = new Set(agent.sandboxes.map((sandbox) => sandbox.sandboxId));
  const selectedSubAgents = new Set(agent.subAgents.map((subAgent) => subAgent.childId));

  return (
    <>
      <DashboardHeader
        breadcrumb={[
          { label: t('title'), href: `/app/${slug}/agents` },
          { label: agent.name },
        ]}
      />
      <AgentChat
        key={`${conv?.id ?? 'empty'}-${settings ?? 'chat'}`}
        slug={slug}
        agentId={agentId}
        conversationId={conv?.id ?? null}
        initialMessages={initialMessages}
        conversations={conversations.map((cv) => ({
          id: cv.id,
          title: cv.title,
          createdAt: fmtDate(cv.createdAt),
          messageCount: cv._count.messages,
          lastMessageAt: cv.messages[0]?.createdAt ? fmtDate(cv.messages[0].createdAt) : null,
          source: parseMessagingSessionTitle(cv.title),
        }))}
        settings={{
          name: agent.name,
          systemPrompt: agent.runtime?.kind === 'hermes' ? '' : agent.systemPrompt ?? '',
          providerId: agent.providerId,
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
          sandboxes: sandboxes.filter((s) => s.id !== agent.runtime?.sandboxId).map((s) => ({
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
              deploymentId: agent.runtime.sandbox.deploymentId,
              dashboardUrl: createHermesDashboardPath(agent.runtime.id),
            };
          })() : null,
        }}
        channelSettings={{
          connections: channelConnections.map(toAgentChannelConnectionClientView),
        }}
        ready={ready}
        agentName={agent.name}
        providerLabel={providerLabel}
        initialSettingsTab={settings === 'channels' ? 'channels' : settings === 'hermes' ? 'hermes' : settings === 'terminal' ? 'terminal' : settings === 'agent' ? 'agent' : null}
      />
    </>
  );
}
