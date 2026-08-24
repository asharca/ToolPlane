import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Bot } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getWorkspaceForUser } from '@/lib/workspace/queries';
import { getConversation, listAgents, listConversations, listProviders } from '@/lib/agents/queries';
import { parseMessagingSessionTitle } from '@/lib/agents/messaging';
import type { HermesUIMessage } from '@/lib/agents/hermes/message-segments';
import { formatInTimeZone, resolveUserTimeZone } from '@/lib/timezone';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardEmptyState, DashboardPage } from '@/components/dashboard/DashboardUI';
import { WorkspaceChat } from '@/components/dashboard/agents/WorkspaceChat';

export const dynamic = 'force-dynamic';

function formatDate(value: Date, timeZone: string, locale: string) {
  return formatInTimeZone(value, timeZone, { month: 'short', day: 'numeric' }, locale);
}

export default async function WorkspaceChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ agent?: string; c?: string }>;
}) {
  const { workspace: slug } = await params;
  const { agent: requestedAgentId, c: requestedConversationId } = await searchParams;
  const [t, locale, user] = await Promise.all([
    getTranslations('console.agents'),
    getLocale(),
    getCurrentUser(),
  ]);
  if (!user) redirect('/app/login');
  const ws = await getWorkspaceForUser(slug, user.id);
  if (!ws) redirect('/app');

  const agents = await listAgents(ws.id);
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

  const requestedAgent = agents.find((agent) => agent.id === requestedAgentId);
  const activeAgent = requestedAgent ?? agents.find((agent) => agent.runtime?.kind === 'hermes'
    ? agent.modelProviders.length > 0
    : Boolean(agent.providerId && agent.model)) ?? agents.find((agent) => agent.runtime?.kind !== 'hermes') ?? agents[0];
  if (!activeAgent) return null;
  const [conversations, providers] = await Promise.all([
    listConversations(ws.id, agents.map((agent) => agent.id)),
    listProviders(ws.id),
  ]);
  const selectedConversationId = requestedConversationId
    ?? conversations.find((item) => item.agentId === activeAgent.id)?.id
    ?? null;
  const loadedConversation = selectedConversationId
    ? await getConversation(selectedConversationId, ws.id)
    : null;
  const conversation = loadedConversation?.agentId === activeAgent.id && !loadedConversation.workSession ? loadedConversation : null;
  const timeZone = resolveUserTimeZone(user);
  const initialMessages: HermesUIMessage[] = (conversation?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role as HermesUIMessage['role'],
    parts: message.parts as HermesUIMessage['parts'],
  }));

  return (
    <>
      <DashboardHeader title={t('chat')} />
      <WorkspaceChat
        slug={slug}
        agentId={activeAgent.id}
        conversationId={conversation?.id ?? null}
        initialMessages={initialMessages}
        agents={agents.map((agent) => {
          const isHermes = agent.runtime?.kind === 'hermes';
          return {
            id: agent.id,
            name: agent.name,
            ready: isHermes ? agent.modelProviders.length > 0 : Boolean(agent.providerId && agent.model),
            runtimeKind: agent.runtime?.kind ?? null,
            providerId: agent.providerId,
            providerIds: agent.modelProviders.map((link) => link.providerId),
            model: agent.model,
            providerLabel: isHermes
              ? agent.modelProviders.map((link) => link.provider.name).join(', ') || t('noModelProvidersSelected')
              : agent.provider
                ? `${agent.provider.name} · ${agent.model ?? t('noModelSelected')}`
                : t('noProviderSelected'),
          };
        })}
        providers={providers.map((provider) => ({ id: provider.id, name: provider.name, models: provider.models }))}
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
        startInChat={Boolean(requestedAgentId || requestedConversationId)}
      />
    </>
  );
}
