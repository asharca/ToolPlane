import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { listAgents, listProviders } from '@/lib/agents/queries';
import {
  getWorkSession,
  listWorkSessions,
  workSessionWorkingDirectory,
} from '@/lib/work/sessions';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { WorkspaceWork } from '@/components/dashboard/work/WorkspaceWork';
import { effectiveStatus } from '@/lib/process/supervisor';
import { resolveModelContext } from '@/lib/agents/model';
import { isWorkRuntimeKind } from '@/lib/agents/runtime-kind';

export const dynamic = 'force-dynamic';

type WorkSummary = Awaited<ReturnType<typeof listWorkSessions>>[number];
type WorkDetail = NonNullable<Awaited<ReturnType<typeof getWorkSession>>>;

function serializeWorkSession(session: WorkSummary | WorkDetail) {
  const detail = 'conversation' in session ? session : null;
  return {
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    task: session.task,
    acceptanceCriteria: session.acceptanceCriteria,
    runtimeKind: session.runtimeKind,
    status: session.status,
    maxSteps: session.maxSteps,
    stepCount: session.stepCount,
    waitingQuestion: session.waitingQuestion,
    result: session.result,
    error: session.error,
    artifacts: Array.isArray(session.artifacts)
      ? session.artifacts.filter((item): item is string => typeof item === 'string')
      : [],
    conversationId: session.conversationId,
    workingDirectory: workSessionWorkingDirectory(session.runtimeSnapshot),
    sandbox: session.sandbox ? {
      id: session.sandbox.id,
      name: session.sandbox.name,
      kind: session.sandbox.kind,
      deploymentId: session.sandbox.deploymentId,
      running: effectiveStatus(session.sandbox.deploymentId, session.sandbox.deployment.status) === 'running',
    } : null,
    messages: detail?.conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts as Array<{
        type: string;
        text?: string;
        filename?: string;
        mediaType?: string;
        url?: string;
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
        isError?: boolean;
        data?: unknown;
      }>,
    })) ?? [],
    approvals: detail?.approvals.map((approval) => ({
      id: approval.id,
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      input: approval.input,
      status: approval.status,
    })) ?? [],
  };
}

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
  const [agents, providers, sessions, selectedSession] = await Promise.all([
    listAgents(workspace.id),
    listProviders(workspace.id),
    listWorkSessions(workspace.id),
    w ? getWorkSession(workspace.id, w) : Promise.resolve(null),
  ]);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));

  return (
    <>
      <DashboardHeader title={t('title')} />
      <WorkspaceWork
        slug={slug}
        workspaceId={workspace.id}
        selectedWorkSessionId={w ?? null}
        selectedSession={selectedSession ? serializeWorkSession(selectedSession) : null}
        requestedAgentId={requestedAgentId}
        providers={providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          format: provider.format,
          models: provider.models,
        }))}
        agents={agents
          .map((agent) => {
            const supportsWork = isWorkRuntimeKind(agent.runtimeKind);
            const isHermes = agent.runtimeKind === 'hermes';
            const runtimeSandbox = isHermes && agent.runtime?.kind === 'hermes'
              && agent.runtime.sandbox.kind === 'hermes'
              && agent.runtime.sandbox.network !== 'none'
              ? agent.runtime.sandbox
              : null;
            const providerIds = isHermes
              ? agent.modelProviders.map((item) => item.providerId)
              : agent.providerId ? [agent.providerId] : [];
            const modelProvider = agent.providerId ? providersById.get(agent.providerId) : null;
            const modelContext = modelProvider && agent.model
              ? resolveModelContext(modelProvider, agent.model)
              : null;
            return {
              id: agent.id,
              name: agent.name,
              supportsWork,
              ready: Boolean(
                supportsWork
                && (isHermes
                  ? providerIds.length > 0 && runtimeSandbox
                  : agent.providerId
                    && agent.model
                    && agent.sandboxes.length === 1
                    && agent.sandboxes[0]?.sandbox.kind === 'docker'
                    && agent.sandboxes[0]?.sandbox.network !== 'none'),
              ),
              runtimeKind: agent.runtimeKind,
              providerId: agent.providerId,
              providerIds,
              providerLabel: isHermes
                ? agent.modelProviders.map((item) => item.provider.name).join(', ')
                : agent.provider?.name ?? '',
              model: agent.model,
              contextWindow: modelContext?.maxTokens ?? null,
              contextWindowEstimated: modelContext?.estimated ?? true,
              sandboxes: runtimeSandbox ? [{
                id: runtimeSandbox.id,
                name: runtimeSandbox.name,
                kind: runtimeSandbox.kind,
                deploymentId: runtimeSandbox.deploymentId,
                running: effectiveStatus(runtimeSandbox.deploymentId, runtimeSandbox.deployment.status) === 'running',
                isDefault: true,
              }] : agent.sandboxes
                .filter((link) => link.sandbox.kind === 'docker' && link.sandbox.network !== 'none')
                .map((link) => ({
                  id: link.sandboxId,
                  name: link.sandbox.name,
                  kind: link.sandbox.kind,
                  deploymentId: link.sandbox.deploymentId,
                  running: effectiveStatus(link.sandbox.deploymentId, link.sandbox.deployment.status) === 'running',
                  isDefault: link.isDefault,
                })),
            };
          })}
        sessions={sessions.map(serializeWorkSession)}
      />
    </>
  );
}
