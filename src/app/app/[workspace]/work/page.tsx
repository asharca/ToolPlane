import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listAgents } from '@/lib/agents/queries';
import { listWorkSessions } from '@/lib/work/sessions';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { WorkspaceWork } from '@/components/dashboard/work/WorkspaceWork';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';

export const dynamic = 'force-dynamic';

export default async function WorkspaceWorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ w?: string; agent?: string }>;
}) {
  const [{ workspace: slug }, { w, agent: requestedAgentId }, user, t] = await Promise.all([params, searchParams, getCurrentUser(), getTranslations('console.work')]);
  if (!user) redirect('/app/login');
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const [agents, sessions] = await Promise.all([listAgents(workspace.id), listWorkSessions(workspace.id)]);

  return (
    <>
      <DashboardHeader title={t('title')} />
      <WorkspaceWork
        slug={slug}
        selectedWorkSessionId={w ?? null}
        requestedAgentId={requestedAgentId}
        agents={agents
          .filter((agent) => agent.runtime?.kind !== 'hermes')
          .map((agent) => ({
          id: agent.id,
          name: agent.name,
          ready: agent.runtime?.kind === 'hermes' ? agent.modelProviders.length > 0 : Boolean(agent.providerId && agent.model),
          runtimeKind: agent.runtime?.kind ?? null,
          sandboxes: agent.sandboxes
            .filter((link) => link.sandbox.id !== agent.runtime?.sandbox?.id)
            .map((link) => ({
              id: link.sandboxId,
              name: link.sandbox.name,
              deploymentId: link.sandbox.deploymentId,
              running: link.sandbox.deployment.status === 'running',
              isDefault: link.isDefault,
            })),
        }))}
        sessions={sessions.map((session) => ({
          id: session.id,
          agentId: session.agentId,
          title: session.title,
          task: session.task,
          status: session.status,
          conversationId: session.conversationId,
          sandbox: session.sandbox ? {
            id: session.sandbox.id,
            name: session.sandbox.name,
            deploymentId: session.sandbox.deploymentId,
            running: session.sandbox.deployment.status === 'running',
          } : null,
          messages: session.conversation.messages.map((message) => ({
            id: message.id,
            role: message.role as HermesUIMessage['role'],
            parts: message.parts as HermesUIMessage['parts'],
          })),
        }))}
      />
    </>
  );
}
