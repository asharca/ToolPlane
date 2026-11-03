import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getWorkspaceForUser } from "@/lib/workspace/queries";
import { listProviders } from "@/lib/agents/queries";
import { listChatDeploymentOptions } from "@/lib/chat/resources";
import {
  getChatThreadForWorkspace,
  listChatAssistantsForWorkspace,
  listRunningChatThreadIds,
} from "@/lib/chat/service";
import { parseChatAssistantModelParameters } from "@/lib/chat/schemas";
import { ChatAssistantRevisionConfigSchema } from "@/lib/chat/revision-types";
import { diffRevisionMcpGrants } from "@/lib/revisions/upgrade-diff";
import type { AgentUIMessage } from "@/lib/agents/message-segments";
import { formatInTimeZone, resolveUserTimeZone } from "@/lib/timezone";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { WorkspaceAssistantChat } from "@/components/dashboard/chat/WorkspaceAssistantChat";
import {
  modelSupportsReasoning,
  resolveModelContext,
} from "@/lib/agents/model";
import {
  assistantChatExpandedCookieName,
  assistantChatGroupPreferencesCookieName,
  assistantChatSidebarCookieName,
  parseBooleanRecordCookie,
} from "@/lib/sidebar-preferences";
import { parseSidebarGroupPreferencesCookie } from "@/lib/sidebar-groups";

export const dynamic = "force-dynamic";

function formatDate(value: Date, timeZone: string, locale: string) {
  return formatInTimeZone(
    value,
    timeZone,
    { month: "short", day: "numeric" },
    locale,
  );
}

export default async function WorkspaceChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    assistant?: string;
    thread?: string;
    agent?: string;
    c?: string;
    newAssistant?: string;
    settings?: string;
  }>;
}) {
  const [{ workspace: slug }, query, user, locale, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getLocale(),
    getTranslations("console.agents"),
  ]);
  if (!user) redirect("/app/login");
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect("/app");
  const cookieStore = await cookies();
  const initialSidebarOpen =
    cookieStore.get(assistantChatSidebarCookieName(workspace.id))?.value !==
    "false";
  const initialExpandedAssistants = parseBooleanRecordCookie(
    cookieStore.get(assistantChatExpandedCookieName(workspace.id))?.value,
  );
  const initialGroupPreferences = parseSidebarGroupPreferencesCookie(
    cookieStore.get(assistantChatGroupPreferencesCookieName(workspace.id))
      ?.value,
  );

  if (query.agent || query.c) {
    const destination = new URLSearchParams();
    if (query.agent) destination.set("agent", query.agent);
    if (query.c) destination.set("c", query.c);
    return redirect(`/app/${encodeURIComponent(slug)}/work?${destination}`);
  }

  const [assistants, providers, deployments, runningThreadIds] =
    await Promise.all([
      listChatAssistantsForWorkspace(workspace.id),
      listProviders(workspace.id),
      listChatDeploymentOptions(user.id, workspace.id),
      listRunningChatThreadIds(user.id, workspace.id),
    ]);
  // The MCP change notice shows until the first thread runs on that revision.
  const usedRevisions = new Set(
    (
      await db.chatThread.findMany({
        where: {
          workspaceId: workspace.id,
          OR: assistants.flatMap((item) =>
            item.revisions[0]
              ? [
                  {
                    assistantId: item.id,
                    assistantRevision: { version: item.revisions[0].version },
                  },
                ]
              : [],
          ),
        },
        distinct: ["assistantId"],
        select: { assistantId: true },
      })
    ).map((thread) => thread.assistantId),
  );
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const activeAssistant =
    assistants.find((item) => item.id === query.assistant) ??
    assistants[0] ??
    null;
  const requestedThreadId =
    query.thread ?? activeAssistant?.threads[0]?.id ?? null;
  let activeThread =
    activeAssistant && requestedThreadId
      ? await getChatThreadForWorkspace(
          workspace.id,
          activeAssistant.id,
          requestedThreadId,
        )
      : null;
  if (!activeThread && query.thread && activeAssistant?.threads[0]) {
    activeThread = await getChatThreadForWorkspace(
      workspace.id,
      activeAssistant.id,
      activeAssistant.threads[0].id,
    );
  }
  const pinnedConfig = ChatAssistantRevisionConfigSchema.safeParse(
    activeThread?.assistantRevision?.config,
  );
  const defaultModelSelection =
    pinnedConfig.success &&
    pinnedConfig.data.modelProviderId &&
    pinnedConfig.data.model
      ? {
          providerId: pinnedConfig.data.modelProviderId,
          model: pinnedConfig.data.model,
        }
      : null;
  const defaultProvider = defaultModelSelection
    ? providersById.get(defaultModelSelection.providerId)
    : null;
  const defaultModelRecord = defaultProvider?.modelRecords.find(
    (model) => model.modelId === defaultModelSelection?.model,
  );
  const reasoningAvailable = Boolean(
    defaultProvider &&
      defaultModelSelection &&
      (defaultModelRecord?.capabilities.includes("reasoning") ||
        modelSupportsReasoning(defaultProvider, defaultModelSelection.model)),
  );
  const timeZone = resolveUserTimeZone(user);
  const initialMessages: AgentUIMessage[] = (activeThread?.messages ?? []).map(
    (message) => ({
      id: message.id,
      role: message.role as AgentUIMessage["role"],
      parts: message.parts as AgentUIMessage["parts"],
    }),
  );

  return (
    <>
      <DashboardHeader title={t("chat")} />
      <WorkspaceAssistantChat
        slug={slug}
        workspaceId={workspace.id}
        initialRunningThreadIds={runningThreadIds}
        initialExpandedAssistants={initialExpandedAssistants}
        initialGroupPreferences={initialGroupPreferences}
        initialSidebarOpen={initialSidebarOpen}
        startCreating={query.newAssistant === "1"}
        startEditing={query.settings === "1"}
        selectedAssistantId={activeAssistant?.id ?? null}
        selectedThreadId={activeThread?.id ?? null}
        reasoningAvailable={reasoningAvailable}
        defaultModelSelection={defaultModelSelection}
        branch={activeThread?.branch ?? null}
        initialMessages={initialMessages}
        providers={providers
          .filter((provider) => provider.apiKey.trim())
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            format: provider.format,
            models: provider.models,
            modelRecords: (provider.modelRecords ?? []).map((model) => ({
              modelId: model.modelId,
              name: model.name,
              group: model.group,
              primaryType: model.primaryType,
              capabilities: model.capabilities,
              inputModalities: model.inputModalities,
              cost: model.cost,
            })),
          }))}
        deployments={deployments}
        assistants={assistants.map((assistant) => {
          const modelProvider = assistant.modelProviderId
            ? providersById.get(assistant.modelProviderId)
            : null;
          const modelContext =
            modelProvider && assistant.model
              ? resolveModelContext(modelProvider, assistant.model)
              : null;
          const threads = assistant.threads.map((thread) => ({
            id: thread.id,
            revisionId: thread.assistantRevisionId,
            revision: thread.assistantRevision?.version ?? null,
            legacyRevisionUnresolved: thread.legacyRevisionUnresolved,
            title: thread.title,
            createdAt: formatDate(thread.createdAt, timeZone, locale),
            lastMessageAt: thread.messages[0]?.createdAt
              ? formatDate(thread.messages[0].createdAt, timeZone, locale)
              : null,
          }));
          if (
            assistant.id === activeAssistant?.id &&
            activeThread &&
            !threads.some((thread) => thread.id === activeThread.id)
          ) {
            const lastMessage = activeThread.messages.at(-1);
            threads.unshift({
              id: activeThread.id,
              revisionId: activeThread.assistantRevisionId,
              revision: activeThread.assistantRevision?.version ?? null,
              legacyRevisionUnresolved: activeThread.legacyRevisionUnresolved,
              title: activeThread.title,
              createdAt: formatDate(activeThread.createdAt, timeZone, locale),
              lastMessageAt: lastMessage?.createdAt
                ? formatDate(lastMessage.createdAt, timeZone, locale)
                : null,
            });
          }
          return {
            id: assistant.id,
            name: assistant.name,
            description: assistant.description,
            pinned: assistant.pinned,
            revision: assistant.currentRevisionVersion,
            mcpGrants: assistant.mcpGrants.map((grant) => ({
              deploymentId: grant.deploymentId,
              allowedToolNames: grant.allowedToolNames,
            })),
            mcpToolChanges: (() => {
              const [current, previous] = assistant.revisions;
              if (!current || !previous || usedRevisions.has(assistant.id))
                return undefined;
              const diff = diffRevisionMcpGrants(
                ChatAssistantRevisionConfigSchema.parse(previous.config)
                  .mcpGrants,
                ChatAssistantRevisionConfigSchema.parse(current.config)
                  .mcpGrants,
                (id) =>
                  deployments.find((deployment) => deployment.id === id)
                    ?.name ?? null,
              );
              return {
                added: [...diff.mcpGrantsAdded, ...diff.mcpToolsAdded],
                removed: [...diff.mcpGrantsRemoved, ...diff.mcpToolsRemoved],
              };
            })(),
            systemPrompt: assistant.systemPrompt,
            modelProviderId: assistant.modelProviderId,
            model: assistant.model,
            modelParameters:
              parseChatAssistantModelParameters(assistant.modelParameters) ??
              null,
            maxSteps: assistant.maxSteps,
            providerName: assistant.modelProvider?.name ?? null,
            contextWindow: modelContext?.maxTokens ?? null,
            contextWindowEstimated: modelContext?.estimated ?? true,
            deploymentIds: assistant.mcpGrants.map(
              (grant) => grant.deploymentId,
            ),
            webSearchAvailable: true,
            threads,
          };
        })}
      />
    </>
  );
}
