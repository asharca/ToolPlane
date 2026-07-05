import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import type { UIMessage } from 'ai';
import { CheckCircle2, MessageSquare, Radio, Users, Wrench } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments, getInstalledSkills } from '@/lib/workspace/queries';
import { listToolkits } from '@/lib/toolkits/queries';
import { listSandboxes } from '@/lib/sandboxes/queries';
import { getAgent, listAgents, listProviders, listConversations, getConversation } from '@/lib/agents/queries';
import { liveStatus } from '@/lib/process/supervisor';
import { deploymentLabel } from '@/lib/workspace/deployment-label';
import { skillLabel } from '@/lib/workspace/skill-label';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { TabBar } from '@/components/dashboard/TabBar';
import { AgentSettingsForm } from '@/components/dashboard/agents/AgentSettingsForm';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';
import { DeleteAgentButton } from '@/components/dashboard/agents/DeleteAgentButton';
import { AgentMessagingPanel } from '@/components/dashboard/agents/AgentMessagingPanel';
import { originFromHeaders } from '@/lib/http/origin';
import { listAgentChannelConnections } from '@/lib/agents/channel-connections';
import { parseMessagingSessionTitle } from '@/lib/agents/messaging';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'chat', label: 'Chat' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'settings', label: 'Settings' },
];

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function metricLabel(count: number, label: string) {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function AgentMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/15 px-2.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span className="shrink-0">{label}</span>
      <span className="truncate font-semibold text-foreground">
        {value}
      </span>
    </span>
  );
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; agentId: string }>;
  searchParams: Promise<{ tab?: string; c?: string }>;
}) {
  const { workspace: slug, agentId } = await params;
  const { tab, c } = await searchParams;
  const current = TABS.some((t) => t.key === tab) ? tab! : 'chat';

  const user = await getCurrentUser();
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const agent = await getAgent(ws.id, agentId);
  if (!agent) notFound();

  const ready = Boolean(agent.providerId && agent.model);
  const base = `/app/${slug}/agents/${agentId}`;
  const channelConnections = await listAgentChannelConnections(ws.id, agentId);
  const toolCount = agent.servers.length + agent.skills.length + agent.toolkits.length + agent.sandboxes.length;
  const runningChannelCount = channelConnections.filter((connection) => connection.status === 'running').length;
  const providerLabel = agent.provider
    ? `${agent.provider.name} · ${agent.model ?? 'no model selected'}`
    : 'No model provider selected';

  let content: React.ReactNode;
  if (current === 'messaging') {
    const origin = originFromHeaders(await headers());
    const connections = channelConnections.map((connection) => ({
      ...connection,
      callbackUrl: `${origin}/api/v1/agent-channels/${connection.id}/events?token=${encodeURIComponent(connection.inboundToken)}`,
    }));
    content = (
      <AgentMessagingPanel
        slug={slug}
        agentId={agentId}
        endpoint={`${origin}/api/v1/agents/${agentId}/messages`}
        connections={connections}
        ready={ready}
        stats={{
          mcp: agent.servers.length,
          skills: agent.skills.length,
          toolkits: agent.toolkits.length,
          sandboxes: agent.sandboxes.length,
          subAgents: agent.subAgents.length,
        }}
      />
    );
  } else if (current === 'settings') {
    const [providers, deployments, skills, toolkits, sandboxes, agents] = await Promise.all([
      listProviders(ws.id),
      getDeployments(ws.id),
      getInstalledSkills(ws.id),
      listToolkits(ws.id),
      listSandboxes(ws.id),
      listAgents(ws.id),
    ]);
    const selectedDeps = new Set(agent.servers.map((s) => s.deploymentId));
    const selectedSkills = new Set(agent.skills.map((s) => s.installedSkill.id));
    const selectedToolkits = new Set(agent.toolkits.map((t) => t.toolkit.id));
    const selectedSandboxes = new Set(agent.sandboxes.map((s) => s.sandbox.id));
    const selectedSubAgents = new Set(agent.subAgents.map((s) => s.child.id));

    content = (
      <>
        <AgentSettingsForm
          slug={slug}
          agentId={agentId}
          name={agent.name}
          systemPrompt={agent.systemPrompt ?? ''}
          providerId={agent.providerId}
          model={agent.model}
          maxSteps={agent.maxSteps}
          providers={providers.map((p) => ({ id: p.id, name: p.name, models: p.models }))}
          deployments={deployments.map((d) => ({
            id: d.id,
            label: deploymentLabel(d).name,
            checked: selectedDeps.has(d.id),
            running: liveStatus(d.id) === 'running',
          }))}
          skills={skills.map((s) => ({
            id: s.id,
            label: skillLabel(s).name,
            checked: selectedSkills.has(s.id),
          }))}
          toolkits={toolkits.map((t) => ({
            id: t.id,
            label: t.name,
            checked: selectedToolkits.has(t.id),
          }))}
          sandboxes={sandboxes.map((s) => ({
            id: s.id,
            label: s.name,
            checked: selectedSandboxes.has(s.id),
            running: liveStatus(s.deploymentId) === 'running',
          }))}
          subAgents={agents
            .filter((a) => a.id !== agentId)
            .map((a) => ({
              id: a.id,
              label: a.name,
              checked: selectedSubAgents.has(a.id),
            }))}
        />
        <div className="max-w-2xl px-8 pb-8">
          <div className="rounded-lg border border-red-200 p-4 dark:border-red-500/30">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Danger zone
            </h2>
            <p className="mt-0.5 mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              Permanently delete this agent and all its conversations.
            </p>
            <DeleteAgentButton slug={slug} agentId={agentId} />
          </div>
        </div>
      </>
    );
  } else {
    const conversations = await listConversations(agentId);
    const activeId = c ?? conversations[0]?.id ?? null;
    const loaded = activeId ? await getConversation(activeId, ws.id) : null;
    const conv = loaded && loaded.agentId === agentId ? loaded : null;
    const initialMessages: UIMessage[] = (conv?.messages ?? []).map((m) => ({
      id: m.id,
      role: m.role as UIMessage['role'],
      parts: m.parts as UIMessage['parts'],
    }));

    content = (
      <AgentChat
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
        channels={channelConnections.map((connection) => ({
          id: connection.id,
          platform: connection.platform,
          platformLabel: connection.platformLabel,
          name: connection.name,
          status: connection.status,
          lastEventAt: connection.lastEventAt ? fmtDate(connection.lastEventAt) : null,
        }))}
        ready={ready}
        agentName={agent.name}
        providerLabel={providerLabel}
      />
    );
  }

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'Agents', href: `/app/${slug}/agents` }, { label: agent.name }]}
      />
      <div className="px-8 pt-4">
        <section className="ui-panel px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{agent.name}</h1>
                <span className={`rounded-md px-2 py-1 text-[11px] font-medium ${ready ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
                  {ready ? 'ready' : 'needs model'}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{providerLabel}</p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <AgentMetric
                icon={CheckCircle2}
                label="Steps"
                value={agent.maxSteps > 0 ? String(agent.maxSteps) : 'default'}
              />
              <AgentMetric icon={Wrench} label="Runtime" value={metricLabel(toolCount, 'binding')} />
              <AgentMetric icon={Users} label="Sub-agents" value={String(agent.subAgents.length)} />
              <AgentMetric icon={Radio} label="Channels" value={`${runningChannelCount}/${channelConnections.length}`} />
              <AgentMetric icon={MessageSquare} label="Sessions" value={String(agent._count.conversations)} />
            </div>
          </div>
        </section>
        <div className="mt-3">
          <TabBar tabs={TABS} current={current} basePath={base} />
        </div>
      </div>
      {content}
    </>
  );
}
