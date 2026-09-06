import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  listAgentDeploymentOptions,
  listProviders,
} from '@/lib/agents/queries';
import {
  getChatThreadForWorkspace,
  listChatAssistantsForWorkspace,
} from '@/lib/chat/service';
import { parseChatAssistantModelParameters } from '@/lib/chat/schemas';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { WorkspaceAssistantChat } from '@/components/dashboard/chat/WorkspaceAssistantChat';
import { modelSupportsReasoning, resolveModelContext } from '@/lib/agents/model';
import {
  getAssistantMarketTemplate,
  listAssistantMarketTemplates,
} from '@/lib/market/skills';
import {
  assistantChatExpandedCookieName,
  assistantChatGroupPreferencesCookieName,
  assistantChatSidebarCookieName,
  parseBooleanRecordCookie,
} from '@/lib/sidebar-preferences';
import { parseSidebarGroupPreferencesCookie } from '@/lib/sidebar-groups';

export const dynamic = 'force-dynamic';

function formatDate(value: Date, timeZone: string, locale: string) {
  return formatInTimeZone(value, timeZone, { month: 'short', day: 'numeric' }, locale);
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
    template?: string;
  }>;
}) {
  const [{ workspace: slug }, query, user, locale, t] = await Promise.all([
    params,
    searchParams,
    getCurrentUser(),
    getLocale(),
    getTranslations('console.agents'),
  ]);
  if (!user) redirect('/app/login');
  const workspace = await getWorkspaceForUser(slug, user.id);
  if (!workspace) redirect('/app');
  const cookieStore = await cookies();
  const initialSidebarOpen = cookieStore.get(assistantChatSidebarCookieName(workspace.id))?.value !== 'false';
  const initialExpandedAssistants = parseBooleanRecordCookie(
    cookieStore.get(assistantChatExpandedCookieName(workspace.id))?.value,
  );
  const initialGroupPreferences = parseSidebarGroupPreferencesCookie(
    cookieStore.get(assistantChatGroupPreferencesCookieName(workspace.id))?.value,
  );

  if (query.agent || query.c) {
    const destination = new URLSearchParams();
    if (query.agent) destination.set('agent', query.agent);
    if (query.c) destination.set('c', query.c);
    return redirect(`/app/${encodeURIComponent(slug)}/work?${destination}`);
  }

  const [assistants, providers, deployments, selectedTemplate, listedTemplates] = await Promise.all([
    listChatAssistantsForWorkspace(workspace.id),
    listProviders(workspace.id),
    listAgentDeploymentOptions(workspace.id),
    query.newAssistant === '1' && query.template
      ? getAssistantMarketTemplate(query.template)
      : Promise.resolve(null),
    listAssistantMarketTemplates({ limit: 12 }),
  ]);
  const templates = selectedTemplate && !listedTemplates.some((item) => item.releaseId === selectedTemplate.releaseId)
    ? [selectedTemplate, ...listedTemplates]
    : listedTemplates;
  const marketTemplates = templates.map((template) => {
    const assistant = template.manifest.assistant;
    const resolvedSlugs = new Set(deployments
      .filter((deployment) => assistant.mcpRequirements.some((requirement) => (
        deployment.catalogSlug === requirement.catalogSlug
      )))
      .map((deployment) => deployment.catalogSlug));
    return {
      releaseId: template.releaseId,
      name: assistant.name,
      summary: template.listing.summary,
      tags: template.listing.tags,
      systemPrompt: assistant.systemPrompt,
      maxSteps: assistant.maxSteps,
      providerFormat: assistant.modelRequirement?.providerFormat ?? null,
      model: assistant.modelRequirement?.model ?? null,
      deploymentIds: deployments.filter((deployment) => assistant.mcpRequirements.some((requirement) => (
        deployment.catalogSlug === requirement.catalogSlug
      ))).map((deployment) => deployment.id),
      missingMcpNames: assistant.mcpRequirements
        .filter((requirement) => !resolvedSlugs.has(requirement.catalogSlug))
        .map((requirement) => requirement.name),
    };
  });
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const activeAssistant = assistants.find((item) => item.id === query.assistant) ?? assistants[0] ?? null;
  const activeAssistantProvider = activeAssistant?.modelProviderId
    ? providersById.get(activeAssistant.modelProviderId)
    : null;
  const activeAssistantModel = activeAssistant?.model;
  const activeAssistantModelRecord = activeAssistantProvider?.modelRecords.find(
    (model) => model.modelId === activeAssistantModel,
  );
  const reasoningAvailable = Boolean(
    activeAssistantProvider
    && activeAssistantModel
    && (
      activeAssistantModelRecord?.capabilities.includes('reasoning')
      || modelSupportsReasoning(activeAssistantProvider, activeAssistantModel)
    ),
  );
  const requestedThreadId = query.thread ?? activeAssistant?.threads[0]?.id ?? null;
  let activeThread = activeAssistant && requestedThreadId
    ? await getChatThreadForWorkspace(workspace.id, activeAssistant.id, requestedThreadId)
    : null;
  if (!activeThread && query.thread && activeAssistant?.threads[0]) {
    activeThread = await getChatThreadForWorkspace(
      workspace.id,
      activeAssistant.id,
      activeAssistant.threads[0].id,
    );
  }
  const timeZone = resolveUserTimeZone(user);
  const initialMessages: HermesUIMessage[] = (activeThread?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role as HermesUIMessage['role'],
    parts: message.parts as HermesUIMessage['parts'],
  }));

  return (
    <>
      <DashboardHeader title={t('chat')} />
      <WorkspaceAssistantChat
        slug={slug}
        workspaceId={workspace.id}
        initialExpandedAssistants={initialExpandedAssistants}
        initialGroupPreferences={initialGroupPreferences}
        initialSidebarOpen={initialSidebarOpen}
        startCreating={query.newAssistant === '1'}
        selectedAssistantId={activeAssistant?.id ?? null}
        selectedThreadId={activeThread?.id ?? null}
        reasoningAvailable={reasoningAvailable}
        branch={activeThread?.branch ?? null}
        initialMessages={initialMessages}
        marketTemplate={marketTemplates.find((template) => template.releaseId === selectedTemplate?.releaseId) ?? null}
        marketTemplates={marketTemplates}
        providers={providers.map((provider) => ({
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
        }))}
        deployments={deployments.map((deployment) => ({
          id: deployment.id,
          name: deployment.label,
          status: deployment.status,
          keywords: deployment.keywords,
        }))}
        assistants={assistants.map((assistant) => {
          const modelProvider = assistant.modelProviderId
            ? providersById.get(assistant.modelProviderId)
            : null;
          const modelContext = modelProvider && assistant.model
            ? resolveModelContext(modelProvider, assistant.model)
            : null;
          const threads = assistant.threads.map((thread) => ({
            id: thread.id,
            title: thread.title,
            createdAt: formatDate(thread.createdAt, timeZone, locale),
            lastMessageAt: thread.messages[0]?.createdAt
              ? formatDate(thread.messages[0].createdAt, timeZone, locale)
              : null,
          }));
          if (
            assistant.id === activeAssistant?.id
            && activeThread
            && !threads.some((thread) => thread.id === activeThread.id)
          ) {
            threads.unshift({
              id: activeThread.id,
              title: activeThread.title,
              createdAt: formatDate(activeThread.createdAt, timeZone, locale),
              lastMessageAt: activeThread.messages.at(-1)?.createdAt
                ? formatDate(activeThread.messages.at(-1)!.createdAt, timeZone, locale)
              : null,
            });
          }
          return {
            id: assistant.id,
            name: assistant.name,
            description: assistant.description,
            pinned: assistant.pinned,
            systemPrompt: assistant.systemPrompt,
            modelProviderId: assistant.modelProviderId,
            model: assistant.model,
            modelParameters: parseChatAssistantModelParameters(assistant.modelParameters) ?? null,
            maxSteps: assistant.maxSteps,
            providerName: assistant.modelProvider?.name ?? null,
            contextWindow: modelContext?.maxTokens ?? null,
            contextWindowEstimated: modelContext?.estimated ?? true,
            deploymentIds: assistant.mcpGrants.map((grant) => grant.deploymentId),
            webSearchAvailable: true,
            threads,
          };
        })}
      />
    </>
  );
}
