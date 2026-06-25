import { redirect, notFound } from 'next/navigation';
import type { UIMessage } from 'ai';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser, getDeployments, getInstalledSkills } from '@/lib/workspace/queries';
import { listToolkits } from '@/lib/toolkits/queries';
import { getAgent, listProviders, listConversations, getConversation } from '@/lib/agents/queries';
import { liveStatus } from '@/lib/process/supervisor';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { TabBar } from '@/components/dashboard/TabBar';
import { AgentSettingsForm } from '@/components/dashboard/agents/AgentSettingsForm';
import { AgentChat } from '@/components/dashboard/agents/AgentChat';
import { DeleteAgentButton } from '@/components/dashboard/agents/DeleteAgentButton';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'chat', label: 'Chat' },
  { key: 'settings', label: 'Settings' },
];

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

  let content: React.ReactNode;
  if (current === 'settings') {
    const [providers, deployments, skills, toolkits] = await Promise.all([
      listProviders(ws.id),
      getDeployments(ws.id),
      getInstalledSkills(ws.id),
      listToolkits(ws.id),
    ]);
    const selectedDeps = new Set(agent.servers.map((s) => s.deploymentId));
    const selectedSkills = new Set(agent.skills.map((s) => s.installedSkill.id));
    const selectedToolkits = new Set(agent.toolkits.map((t) => t.toolkit.id));

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
            label: d.server.name,
            checked: selectedDeps.has(d.id),
            running: liveStatus(d.id) === 'running',
          }))}
          skills={skills.map((s) => ({
            id: s.id,
            label: s.skill.name,
            checked: selectedSkills.has(s.id),
          }))}
          toolkits={toolkits.map((t) => ({
            id: t.id,
            label: t.name,
            checked: selectedToolkits.has(t.id),
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
        }))}
        ready={ready}
      />
    );
  }

  return (
    <>
      <DashboardHeader
        breadcrumb={[{ label: 'Agents', href: `/app/${slug}/agents` }, { label: agent.name }]}
      />
      <div className="px-8 pt-6">
        <TabBar tabs={TABS} current={current} basePath={base} />
      </div>
      {content}
    </>
  );
}
