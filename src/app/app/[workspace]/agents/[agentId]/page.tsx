import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import type { UIMessage } from 'ai';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments, getInstalledSkills } from '@/lib/workspace/queries';
import { listToolkits } from '@/lib/toolkits/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import { getAgent, listAgents, listProviders, listConversations, getConversation } from '@/lib/agents/queries';
import { liveStatus } from '@/lib/process/supervisor';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';
import { originFromHeaders } from '@/lib/http/origin';
import { listAgentChannelConnections } from '@/lib/agents/channel-connections';
import { parseMessagingSessionTitle } from '@/lib/agents/messaging';

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

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const agent = await getAgent(ws.id, agentId);
  if (!agent) notFound();

  const ready = Boolean(agent.providerId && agent.model);
  const providerLabel = agent.provider
    ? `${agent.provider.name} · ${agent.model ?? 'no model selected'}`
    : 'No model provider selected';
  const origin = originFromHeaders(await headers());

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
    getDeployments(ws.id),
    getInstalledSkills(ws.id),
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

  const selectedDeps = new Set(agent.servers.map((s) => s.deploymentId));
  const selectedSkills = new Set(agent.skills.map((s) => s.installedSkill.id));
  const selectedToolkits = new Set(agent.toolkits.map((t) => t.toolkit.id));
  const selectedSandboxes = new Set(agent.sandboxes.map((s) => s.sandbox.id));
  const selectedSubAgents = new Set(agent.subAgents.map((s) => s.child.id));

  return (
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
        systemPrompt: agent.systemPrompt ?? '',
        providerId: agent.providerId,
        model: agent.model,
        maxSteps: agent.maxSteps,
        providers: providers.map((p) => ({ id: p.id, name: p.name, models: p.models })),
        deployments: deployments.map((d) => ({
          id: d.id,
          label: deploymentLabel(d).name,
          checked: selectedDeps.has(d.id),
          running: liveStatus(d.id) === 'running',
        })),
        skills: skills.map((s) => ({
          id: s.id,
          label: skillLabel(s).name,
          checked: selectedSkills.has(s.id),
        })),
        toolkits: toolkits.map((t) => ({
          id: t.id,
          label: t.name,
          checked: selectedToolkits.has(t.id),
        })),
        sandboxes: sandboxes.map((s) => ({
          id: s.id,
          label: s.name,
          checked: selectedSandboxes.has(s.id),
          running: liveStatus(s.deploymentId) === 'running',
        })),
        subAgents: agents
          .filter((a) => a.id !== agentId)
          .map((a) => ({
            id: a.id,
            label: a.name,
            checked: selectedSubAgents.has(a.id),
          })),
      }}
      channelSettings={{
        endpoint: `${origin}/api/v1/agents/${agentId}/messages`,
        connections: channelConnections.map((connection) => ({
          ...connection,
          callbackUrl: `${origin}/api/v1/agent-channels/${connection.id}/events?token=${encodeURIComponent(connection.inboundToken)}`,
        })),
        stats: {
          mcp: agent.servers.length,
          skills: agent.skills.length,
          toolkits: agent.toolkits.length,
          sandboxes: agent.sandboxes.length,
          subAgents: agent.subAgents.length,
        },
      }}
      ready={ready}
      agentName={agent.name}
      providerLabel={providerLabel}
      initialSettingsTab={settings === 'channels' ? 'channels' : settings === 'agent' ? 'agent' : null}
    />
  );
}
