import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Bot } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import {
  getConversation,
  listAgentDeploymentOptions,
  listAgents,
  listConversations,
  listProviders,
} from '@/lib/agents/queries';
import { parseMessagingSessionTitle } from '@/lib/agents/messaging';
import { isDedicatedSandboxRuntimeKind } from '@/lib/agents/runtime-kind';
import {
  getChatThreadForWorkspace,
  listChatAssistantsForWorkspace,
} from '@/lib/chat/service';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import { normalizeReasoningEffort } from '@/lib/agents/constants';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardEmptyState, DashboardPage } from '@/components/dashboard/DashboardUI';
import { WorkspaceChat } from '@/components/dashboard/agents/WorkspaceChat';
import { WorkspaceAssistantChat } from '@/components/dashboard/chat/WorkspaceAssistantChat';
import { modelSupportsReasoning, resolveModelContext } from '@/lib/agents/model';
import {
  getAssistantMarketTemplate,
  listAssistantMarketTemplates,
} from '@/lib/market/skills';

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

  if (query.agent || query.c) {
    const agents = await listAgents(workspace.id);
    if (agents.length === 0) {
      return (
        <>
          <DashboardHeader title={t('chat')} />
          <DashboardPage>
            <DashboardEmptyState
              icon={Bot}
              title={t('noAgentsYet')}
              description={t('createAnAgentThenConnectItToToolsAndExternalMessagingAdapters')}
              actions={(
                <Link href={`/app/${encodeURIComponent(slug)}/agents`} className="ui-button-primary">
                  <Bot className="size-4" />
                  {t('createAgent')}
                </Link>
              )}
            />
          </DashboardPage>
        </>
      );
    }

    const [conversations, providers] = await Promise.all([
      listConversations(workspace.id, agents.map((agent) => agent.id)),
      listProviders(workspace.id),
    ]);
    const chatAgents = agents.map((agent) => {
      const isHermes = agent.runtimeKind === 'hermes';
      const sandboxReady = agent.sandboxes.length === 1
        && agent.sandboxes[0]?.sandbox.kind === 'docker'
        && agent.sandboxes[0]?.sandbox.network !== 'none';
      return {
        id: agent.id,
        name: agent.name,
        ready: isHermes
          ? agent.modelProviders.length > 0
          : Boolean(
              agent.providerId
              && agent.model
              && (!isDedicatedSandboxRuntimeKind(agent.runtimeKind) || sandboxReady),
            ),
        runtimeKind: agent.runtimeKind,
        providerId: agent.providerId,
        providerIds: agent.modelProviders.map((link) => link.providerId),
        model: agent.model,
        providerLabel: isHermes
          ? agent.modelProviders.map((link) => link.provider.name).join(', ') || t('noModelProvidersSelected')
          : agent.provider
            ? `${agent.provider.name} · ${agent.model ?? t('noModelSelected')}`
            : t('noProviderSelected'),
      };
    });
    const activeAgent = chatAgents.find((agent) => agent.id === query.agent)
      ?? chatAgents.find((agent) => agent.ready)
      ?? chatAgents[0];
    if (!activeAgent) return null;
    const activeModel = activeAgent.model;
    const activeProvider = providers.find((provider) => provider.id === activeAgent.providerId);
    const activeModelRecord = activeProvider?.modelRecords.find((model) => model.modelId === activeModel);
    const reasoningAvailable = activeAgent.runtimeKind === 'hermes' || Boolean(
      !isDedicatedSandboxRuntimeKind(activeAgent.runtimeKind)
      && activeModel
      && activeProvider
      && (
        activeModelRecord?.capabilities.includes('reasoning')
        || modelSupportsReasoning(activeProvider, activeModel)
      ),
    );
    const selectedConversationId = query.c
      ?? conversations.find((item) => item.agentId === activeAgent.id)?.id
      ?? null;
    const loadedConversation = selectedConversationId
      ? await getConversation(selectedConversationId, workspace.id)
      : null;
    const conversation = loadedConversation?.agentId === activeAgent.id && !loadedConversation.workSession
      ? loadedConversation
      : null;
    const timeZone = resolveUserTimeZone(user);
    const initialMessages: HermesUIMessage[] = (conversation?.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role as HermesUIMessage['role'],
      parts: message.parts as HermesUIMessage['parts'],
    }));
    const conversationSource = parseMessagingSessionTitle(conversation?.title ?? null);

    return (
      <>
        <DashboardHeader title={t('chat')} />
        <WorkspaceChat
          slug={slug}
          workspaceId={workspace.id}
          agentId={activeAgent.id}
          conversationId={conversation?.id ?? null}
          initialMessages={initialMessages}
          initialReasoningEffort={normalizeReasoningEffort(conversation?.reasoningEffort) ?? 'default'}
          reasoningAvailable={reasoningAvailable}
          agents={chatAgents}
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
          conversations={conversations.map((item) => {
            const source = parseMessagingSessionTitle(item.title);
            return {
              id: item.id,
              agentId: item.agentId,
              title: item.title,
              createdAt: formatDate(item.createdAt, timeZone, locale),
              lastMessageAt: item.messages[0]?.createdAt
                ? formatDate(item.messages[0].createdAt, timeZone, locale)
                : null,
              source,
              editable: !item.publicApiConversation && !source,
            };
          })}
          hermesSelection={activeAgent.runtimeKind === 'hermes' ? {
            profile: conversation?.hermesProfile ?? 'default',
            provider: conversation?.hermesProvider ?? null,
            model: conversation?.hermesModel ?? null,
            hasMessages: initialMessages.length > 0,
            editable: !conversation?.publicApiConversation && !conversationSource,
          } : undefined}
          startInChat
        />
      </>
    );
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
            pinned: assistant.pinned,
            systemPrompt: assistant.systemPrompt,
            modelProviderId: assistant.modelProviderId,
            model: assistant.model,
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
