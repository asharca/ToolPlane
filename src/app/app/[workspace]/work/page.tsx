import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import {
  getConversation,
  listAgents,
  listConversations,
  listProviders,
} from "@/lib/agents/queries";
import { parseMessagingSessionTitle } from "@/lib/agents/messaging";
import {
  getWorkSession,
  listWorkSessions,
  workSessionWorkingDirectory,
} from "@/lib/work/sessions";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { WorkspaceWork } from "@/components/dashboard/work/WorkspaceWork";
import { WorkspaceWelcome } from "@/components/dashboard/WorkspaceWelcome";
import { effectiveStatus } from "@/lib/process/supervisor";
import { resolveModelContext } from "@/lib/agents/model";
import { isWorkRuntimeKind } from "@/lib/agents/runtime-kind";
import { normalizeReasoningEffort } from "@/lib/agents/constants";
import { isWorkSessionTitlePending } from "@/lib/work/coordinator";
import {
  parseBooleanRecordCookie,
  workAgentGroupsCookieName,
  workAgentGroupPreferencesCookieName,
  workSidebarCookieName,
} from "@/lib/sidebar-preferences";
import { parseSidebarGroupPreferencesCookie } from "@/lib/sidebar-groups";
import { getConversationWorkspaceSandbox } from "@/lib/agents/conversation-workspace";

export const dynamic = "force-dynamic";

type WorkSummary = Awaited<ReturnType<typeof listWorkSessions>>[number];
type WorkDetail = NonNullable<Awaited<ReturnType<typeof getWorkSession>>>;

function serializeMessages(
  messages: NonNullable<
    Awaited<ReturnType<typeof getConversation>>
  >["messages"],
) {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    createdAt: message.createdAt.toISOString(),
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
  }));
}

function serializeWorkSession(session: WorkSummary | WorkDetail) {
  const detail = "conversation" in session ? session : null;
  return {
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    task: session.task,
    acceptanceCriteria: session.acceptanceCriteria,
    runtimeKind: session.runtimeKind,
    readOnly: session.readOnly,
    agentRevisionId: session.agentRevisionId,
    legacyRevisionUnresolved: session.legacyRevisionUnresolved,
    modelName: session.modelName,
    contextWindow: session.contextWindow,
    contextWindowEstimated: session.contextWindowEstimated,
    status: session.status,
    startedAt: session.startedAt?.toISOString() ?? null,
    completedAt: session.completedAt?.toISOString() ?? null,
    waitingQuestion: session.waitingQuestion,
    result: session.result,
    error: session.error,
    artifacts: Array.isArray(session.artifacts)
      ? session.artifacts.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    conversationId: session.conversationId,
    reasoningEffort:
      normalizeReasoningEffort(detail?.conversation.reasoningEffort) ?? null,
    hermesProfile: detail?.conversation.hermesProfile ?? null,
    hermesProvider: detail?.conversation.hermesProvider ?? null,
    hermesModel: detail?.conversation.hermesModel ?? null,
    workingDirectory: workSessionWorkingDirectory(session.runtimeSnapshot),
    sandbox: session.sandbox
      ? {
          id: session.sandbox.id,
          name: session.sandbox.name,
          kind: session.sandbox.kind,
          status: session.sandbox.deployment.status,
          deploymentId: session.sandbox.deploymentId,
          running:
            effectiveStatus(
              session.sandbox.deploymentId,
              session.sandbox.deployment.status,
            ) === "running",
        }
      : null,
    messages: serializeMessages(detail?.conversation.messages ?? []),
    approvals:
      detail?.approvals.map((approval) => ({
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
  searchParams: Promise<{
    w?: string;
    agent?: string;
    c?: string;
    welcome?: string;
    mode?: string;
  }>;
}) {
  const [
    { workspace: slug },
    { w, c, agent: requestedAgentId, welcome, mode },
    user,
    t,
  ] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getTranslations("console.work"),
  ]);
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  if (mode === "a2a") return notFound();
  const titlePending = Boolean(w && !c && isWorkSessionTitlePending(w));
  const [
    agents,
    providers,
    sessions,
    selectedSession,
    conversation,
    cookieStore,
  ] = await Promise.all([
    listAgents(workspace.id),
    listProviders(workspace.id),
    listWorkSessions(workspace.id),
    w && !c ? getWorkSession(workspace.id, w) : Promise.resolve(null),
    c ? getConversation(c, workspace.id) : Promise.resolve(null),
    cookies(),
  ]);
  const initialSidebarOpen =
    cookieStore.get(workSidebarCookieName(workspace.id))?.value !== "false";
  const initialExpandedAgents = parseBooleanRecordCookie(
    cookieStore.get(workAgentGroupsCookieName(workspace.id))?.value,
  );
  const initialGroupPreferences = parseSidebarGroupPreferencesCookie(
    cookieStore.get(workAgentGroupPreferencesCookieName(workspace.id))?.value,
  );
  if (
    c &&
    (!conversation ||
      !agents.some((agent) => agent.id === conversation.agentId) ||
      (requestedAgentId && requestedAgentId !== conversation.agentId))
  )
    return notFound();
  if (conversation?.workSession)
    return redirect(
      `/app/${encodeURIComponent(slug)}/work?w=${encodeURIComponent(conversation.workSession.id)}`,
    );
  const [conversationSandbox, workSandbox] = await Promise.all([
    Promise.resolve(conversation?.boundSandbox ?? null),
    selectedSession && !selectedSession.readOnly
      ? getConversationWorkspaceSandbox({
          workspaceId: workspace.id,
          agentId: selectedSession.agentId,
          conversationId: selectedSession.conversationId,
        })
      : Promise.resolve(selectedSession?.sandbox ?? null),
  ]);
  const source = parseMessagingSessionTitle(conversation?.title);
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const conversations = await listConversations(
    workspace.id,
    agents.map((agent) => agent.id),
  );

  return (
    <>
      <DashboardHeader title={t("title")} />
      {welcome === "1" ? (
        <WorkspaceWelcome
          slug={slug}
          name={workspace.name}
          isOwner={workspace.ownerId === user.id}
        />
      ) : null}
      <WorkspaceWork
        slug={slug}
        workspaceId={workspace.id}
        initialExpandedAgents={initialExpandedAgents}
        initialGroupPreferences={initialGroupPreferences}
        initialSidebarOpen={initialSidebarOpen}
        selectedWorkSessionId={c ? null : (w ?? null)}
        selectedSession={
          selectedSession
            ? {
                ...serializeWorkSession({
                  ...selectedSession,
                  sandbox: workSandbox,
                }),
                titlePending,
              }
            : null
        }
        selectedConversation={
          conversation
            ? {
                id: conversation.id,
                agentId: conversation.agentId,
                title: conversation.title,
                source,
                agentRevisionId: conversation.agentRevisionId,
                legacyRevisionUnresolved: conversation.legacyRevisionUnresolved,
                runtimeKind: conversation.runtimeKind ?? undefined,
                modelName: conversation.modelName,
                contextWindow: conversation.contextWindow,
                contextWindowEstimated:
                  conversation.contextWindowEstimated ?? undefined,
                sandbox: conversationSandbox
                  ? {
                      ...conversationSandbox,
                      status: conversationSandbox.deployment.status,
                      running:
                        effectiveStatus(
                          conversationSandbox.deploymentId,
                          conversationSandbox.deployment.status,
                        ) === "running",
                    }
                  : null,
                readOnly: conversation.readOnly,
                reasoningEffort: normalizeReasoningEffort(
                  conversation.reasoningEffort,
                ),
                hermesProfile: conversation.hermesProfile,
                hermesProvider: conversation.hermesProvider,
                hermesModel: conversation.hermesModel,
                messages: serializeMessages(conversation.messages),
              }
            : null
        }
        requestedAgentId={requestedAgentId}
        hasChannels={agents.some((agent) => Boolean(agent._count?.channels))}
        conversations={conversations.map((conversation) => ({
          id: conversation.id,
          agentId: conversation.agentId,
          title: conversation.title,
          source: parseMessagingSessionTitle(conversation.title),
        }))}
        agents={agents.map((agent) => {
          const supportsWork =
            isWorkRuntimeKind(agent.runtimeKind) && !agent.retiredAt;
          const providerIds = agent.providerId ? [agent.providerId] : [];
          const modelProvider = agent.providerId
            ? providersById.get(agent.providerId)
            : null;
          const modelContext =
            modelProvider && agent.model
              ? resolveModelContext(modelProvider, agent.model)
              : null;
          return {
            id: agent.id,
            name: agent.name,
            pinned: agent.pinned,
            supportsWork,
            ready:
              supportsWork &&
              agent.runtimeKind === "pi-sdk" &&
              agent.currentRevisionVersion > 0,
            runtimeKind: agent.runtimeKind,
            currentRevisionVersion: agent.currentRevisionVersion,
            providerId: agent.providerId,
            providerIds,
            providerLabel: agent.provider?.name ?? "",
            model: agent.model,
            contextWindow: modelContext?.maxTokens ?? null,
            contextWindowEstimated: modelContext?.estimated ?? true,
            sandboxes: agent.sandboxes
              .filter(
                (link) =>
                  link.sandbox.kind === "docker" &&
                  link.sandbox.network !== "none",
              )
              .map((link) => {
                const status = effectiveStatus(
                  link.sandbox.deploymentId,
                  link.sandbox.deployment.status,
                );
                return {
                  id: link.sandboxId,
                  name: link.sandbox.name,
                  kind: link.sandbox.kind,
                  deploymentId: link.sandbox.deploymentId,
                  status,
                  running: status === "running",
                  isDefault: link.isDefault,
                };
              }),
          };
        })}
        sessions={sessions.map((session) =>
          serializeWorkSession({
            ...session,
            sandbox: session.runtimeKind === "hermes" ? session.sandbox : null,
          }),
        )}
      />
    </>
  );
}
